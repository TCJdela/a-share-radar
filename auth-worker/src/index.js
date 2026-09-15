const encoder=new TextEncoder();

export default {
  async fetch(request,env){
    const origin=request.headers.get("Origin")||"";
    const allowed=env.APP_ORIGIN||"https://tcjdela.github.io";
    const cors={"Access-Control-Allow-Origin":origin===allowed?origin:allowed,"Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS","Vary":"Origin"};
    if(request.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
    try{
      const url=new URL(request.url);
      if(url.pathname==="/health")return json({ok:true},200,cors);
      if(url.pathname==="/auth/login"&&request.method==="POST")return await login(request,env,cors);
      if(url.pathname==="/auth/logout"&&request.method==="POST")return await logout(request,env,cors);
      if(url.pathname==="/auth/me"&&request.method==="GET")return await me(request,env,cors);
      if(url.pathname==="/auth/change-password"&&request.method==="POST")return await changePassword(request,env,cors);
      if(url.pathname==="/admin/accounts"&&request.method==="GET")return await listAccounts(request,env,cors);
      if(url.pathname==="/admin/accounts"&&request.method==="POST")return await addAccount(request,env,cors);
      const match=url.pathname.match(/^\/admin\/accounts\/([^/]+)$/);
      if(match&&request.method==="PATCH")return await toggleAccount(request,env,cors,match[1]);
      return json({error:"接口不存在"},404,cors);
    }catch(error){return json({error:error.message||"服务异常"},500,cors)}
  }
};

async function ensureSuper(env){
  if(!env.SUPER_PASSWORD)throw new Error("认证服务尚未配置超级账号密钥");
  const phone=env.SUPER_PHONE||"15858198564";
  const exists=await env.DB.prepare("SELECT id FROM accounts WHERE phone=?").bind(phone).first();
  if(exists)return;
  const id=crypto.randomUUID(),pass=await hashPassword(env.SUPER_PASSWORD);
  await env.DB.prepare("INSERT INTO accounts(id,phone,password_hash,password_salt,role,active,must_change,created_at) VALUES(?,?,?,?,?,1,0,?)").bind(id,phone,pass.hash,pass.salt,"super",new Date().toISOString()).run();
}
async function login(request,env,cors){
  await ensureSuper(env);
  const body=await request.json(),phone=String(body.phone||"").trim(),password=String(body.password||"");
  if(!/^1\d{10}$/.test(phone)||!password)return json({error:"手机号或密码错误"},400,cors);
  const ip=request.headers.get("CF-Connecting-IP")||"unknown",since=new Date(Date.now()-15*60*1000).toISOString();
  const recent=await env.DB.prepare("SELECT COUNT(*) n FROM auth_logs WHERE ip=? AND phone=? AND success=0 AND created_at>?").bind(ip,phone,since).first();
  if(Number(recent&&recent.n)>=8)return json({error:"尝试次数过多，请15分钟后再试"},429,cors);
  const user=await env.DB.prepare("SELECT * FROM accounts WHERE phone=?").bind(phone).first();
  const ok=user&&user.active&&await verifyPassword(password,user.password_salt,user.password_hash);
  await env.DB.prepare("INSERT INTO auth_logs(id,phone,ip,success,created_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(),phone,ip,ok?1:0,new Date().toISOString()).run();
  if(!ok)return json({error:"手机号或密码错误"},401,cors);
  const raw=randomToken(),tokenHash=await sha256(raw),expires=new Date(Date.now()+12*60*60*1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)").bind(crypto.randomUUID(),user.id,tokenHash,expires,new Date().toISOString()).run();
  return json({token:raw,user:publicUser(user)},200,cors);
}
async function requireUser(request,env,role){
  const value=request.headers.get("Authorization")||"";
  if(!value.startsWith("Bearer "))throw httpError("未登录或登录已过期",401);
  const hash=await sha256(value.slice(7));
  const user=await env.DB.prepare("SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND a.active=1").bind(hash,new Date().toISOString()).first();
  if(!user)throw httpError("未登录或登录已过期",401);
  if(role&&user.role!==role)throw httpError("无权访问",403);
  return user;
}
async function me(request,env,cors){try{return json({user:publicUser(await requireUser(request,env))},200,cors)}catch(e){return json({error:e.message},e.status||401,cors)}}
async function logout(request,env,cors){
  const value=request.headers.get("Authorization")||"";
  if(value.startsWith("Bearer "))await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(value.slice(7))).run();
  return json({ok:true},200,cors);
}
async function changePassword(request,env,cors){
  try{
    const user=await requireUser(request,env),body=await request.json(),oldPass=String(body.old_password||""),newPass=String(body.new_password||"");
    if(!(await verifyPassword(oldPass,user.password_salt,user.password_hash)))return json({error:"原密码错误"},400,cors);
    if(newPass.length<8)return json({error:"新密码至少8位"},400,cors);
    const pass=await hashPassword(newPass);
    await env.DB.batch([
      env.DB.prepare("UPDATE accounts SET password_hash=?,password_salt=?,must_change=0 WHERE id=?").bind(pass.hash,pass.salt,user.id),
      env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id)
    ]);
    return json({ok:true},200,cors);
  }catch(e){return json({error:e.message},e.status||400,cors)}
}
async function listAccounts(request,env,cors){
  try{await requireUser(request,env,"super");const rows=await env.DB.prepare("SELECT id,phone,role,active,must_change,created_at FROM accounts ORDER BY role DESC,created_at DESC").all();return json({accounts:rows.results||[]},200,cors)}
  catch(e){return json({error:e.message},e.status||403,cors)}
}
async function addAccount(request,env,cors){
  try{
    await requireUser(request,env,"super");const body=await request.json(),phone=String(body.phone||"").trim();
    if(!/^1\d{10}$/.test(phone))return json({error:"请输入有效的11位手机号"},400,cors);
    const pass=await hashPassword(env.DEFAULT_PASSWORD||"123456");
    await env.DB.prepare("INSERT INTO accounts(id,phone,password_hash,password_salt,role,active,must_change,created_at) VALUES(?,?,?,?,?,1,1,?)").bind(crypto.randomUUID(),phone,pass.hash,pass.salt,"user",new Date().toISOString()).run();
    return json({ok:true},201,cors);
  }catch(e){return json({error:/UNIQUE/.test(e.message)?"该手机号已存在":e.message},e.status||400,cors)}
}
async function toggleAccount(request,env,cors,id){
  try{
    await requireUser(request,env,"super");const body=await request.json(),target=await env.DB.prepare("SELECT role FROM accounts WHERE id=?").bind(id).first();
    if(!target)return json({error:"账号不存在"},404,cors);
    if(target.role==="super")return json({error:"超级账号不可停用"},400,cors);
    await env.DB.prepare("UPDATE accounts SET active=? WHERE id=?").bind(body.active?1:0,id).run();return json({ok:true},200,cors);
  }catch(e){return json({error:e.message},e.status||400,cors)}
}
async function hashPassword(password){
  const salt=crypto.getRandomValues(new Uint8Array(16)),key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations:210000},key,256);
  return{salt:b64(salt),hash:b64(new Uint8Array(bits))};
}
async function verifyPassword(password,salt,expected){
  const key=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:unb64(salt),iterations:210000},key,256);
  return timingSafe(b64(new Uint8Array(bits)),expected);
}
async function sha256(value){const bits=await crypto.subtle.digest("SHA-256",encoder.encode(value));return b64(new Uint8Array(bits))}
function randomToken(){return b64(crypto.getRandomValues(new Uint8Array(32)))}
function b64(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")}
function unb64(value){value=value.replace(/-/g,"+").replace(/_/g,"/");while(value.length%4)value+="=";return Uint8Array.from(atob(value),c=>c.charCodeAt(0))}
function timingSafe(a,b){if(a.length!==b.length)return false;let out=0;for(let i=0;i<a.length;i++)out|=a.charCodeAt(i)^b.charCodeAt(i);return out===0}
function publicUser(x){return{id:x.id,phone:x.phone,role:x.role,must_change:!!x.must_change}}
function json(data,status,cors){return new Response(JSON.stringify(data),{status,headers:Object.assign({"Content-Type":"application/json;charset=UTF-8"},cors)})}
function httpError(message,status){const e=new Error(message);e.status=status;return e}
