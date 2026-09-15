(function(){
"use strict";
var base=String(window.AUTH_API_BASE||"").replace(/\/$/,""),token=sessionStorage.getItem("ashare.session")||"",current=null;
var $=function(s){return document.querySelector(s)};
window.AShareAuth={enabled:!!base,isSuper:false,user:null};
if(!base)return;

document.body.classList.add("locked");
$("#loginShell").hidden=false;

async function api(path,options){
  options=options||{};var headers=Object.assign({"Content-Type":"application/json"},options.headers||{});
  if(token)headers.Authorization="Bearer "+token;
  var res=await fetch(base+path,Object.assign({},options,{headers:headers}));
  var data={};try{data=await res.json()}catch(e){}
  if(!res.ok)throw new Error(data.error||"认证服务暂时不可用");
  return data;
}
function unlock(user){
  current=user;window.AShareAuth.user=user;window.AShareAuth.isSuper=user.role==="super";
  document.body.classList.remove("locked");$("#loginShell").hidden=true;
  var pill=$("#userPill"),logout=$("#logoutBtn");pill.textContent=user.phone+" · "+(user.role==="super"?"超级管理员":"用户");pill.classList.remove("hidden");logout.classList.remove("hidden");
  document.querySelectorAll(".admin-only").forEach(function(x){x.classList.toggle("hidden",user.role!=="super")});
  if(user.role==="super")loadAccounts();
}
function lock(message){
  document.body.classList.add("locked");$("#loginShell").hidden=false;$("#loginError").textContent=message||"";
}
async function restore(){
  if(!token){lock();return}
  try{var data=await api("/auth/me");unlock(data.user)}catch(e){token="";sessionStorage.removeItem("ashare.session");lock("登录已过期，请重新登录")}
}
$("#loginForm").onsubmit=async function(e){
  e.preventDefault();var phone=$("#loginPhone").value.trim(),password=$("#loginPassword").value;
  $("#loginError").textContent="正在验证…";
  try{var data=await api("/auth/login",{method:"POST",body:JSON.stringify({phone:phone,password:password})});token=data.token;sessionStorage.setItem("ashare.session",token);$("#loginPassword").value="";unlock(data.user)}
  catch(err){$("#loginError").textContent=err.message}
};
$("#logoutBtn").onclick=async function(){try{await api("/auth/logout",{method:"POST"})}catch(e){}token="";sessionStorage.removeItem("ashare.session");window.AShareAuth.isSuper=false;lock("已退出登录")};
async function loadAccounts(){
  if(!window.AShareAuth.isSuper)return;
  try{var data=await api("/admin/accounts");$("#accountRows").innerHTML=data.accounts.map(function(x){return"<tr><td>"+x.phone+"</td><td>"+(x.role==="super"?"超级管理员":"用户")+"</td><td>"+(x.active?"启用":"停用")+"</td><td>"+x.created_at+"</td><td>"+(x.role==="super"?"不可操作":"<button class='btn small' data-account-toggle='"+x.id+"' data-active='"+x.active+"'>"+(x.active?"停用":"启用")+"</button>")+"</td></tr>"}).join("");
    document.querySelectorAll("[data-account-toggle]").forEach(function(b){b.onclick=async function(){await api("/admin/accounts/"+b.dataset.accountToggle,{method:"PATCH",body:JSON.stringify({active:b.dataset.active!=="true"})});loadAccounts()}});
  }catch(e){$("#accountRows").innerHTML="<tr><td colspan='5' class='empty'>"+e.message+"</td></tr>"}
}
$("#accountForm").onsubmit=async function(e){
  e.preventDefault();var phone=$("#accountPhone").value.trim();
  try{await api("/admin/accounts",{method:"POST",body:JSON.stringify({phone:phone})});$("#accountPhone").value="";loadAccounts()}
  catch(err){alert(err.message)}
};
window.AShareAuth.reloadAccounts=loadAccounts;
restore();
})();