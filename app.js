(function(){
"use strict";
var API={
  list:"https://push2.eastmoney.com/api/qt/clist/get",
  quote:"https://push2.eastmoney.com/api/qt/stock/get",
  kline:"https://push2his.eastmoney.com/api/qt/stock/kline/get",
  trend:"https://push2his.eastmoney.com/api/qt/stock/trends2/get",
  suggest:"https://searchapi.eastmoney.com/api/suggest/get",
  ann:"https://np-anotice-stock.eastmoney.com/api/security/ann",
  tencentQuote:"https://qt.gtimg.cn/q=",
  tencentK:"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
  tencentTrend:"https://web.ifzq.gtimg.cn/appstock/app/minute/query",
  tencentSearch:"https://smartbox.gtimg.cn/s3/"
};
var DEFAULT_SECTORS=[
 {label:"PCB",aliases:["PCB","印制电路板"]},{label:"半导体",aliases:["半导体"]},{label:"光纤",aliases:["光纤","光通信"]},
 {label:"贵金属",aliases:["贵金属","黄金"]},{label:"小金属",aliases:["小金属"]},{label:"化工",aliases:["化工","化学制品"]},
 {label:"油气",aliases:["油气开采","油气"]},{label:"粮食",aliases:["粮食概念","种植业"]},{label:"MLCC",aliases:["MLCC","被动元件"]}
];
var META_BOARD=/昨日|涨停|连板|ST|预盈|融资融券|深股通|沪股通|百元股|机构重仓|基金重仓|MSCI|标准普尔|证金持股|AH股|次新股|破净股|低价股|高送转|转债标的/;
var state={
  hot:[],boards:[],fixed:readStore("ashare.fixed",DEFAULT_SECTORS.map(function(x){return{label:x.label,name:x.label,code:""}})),watch:readStore("ashare.watch",[]),
  candidates:[],watchRows:[],searchRows:[],universe:null,activeBoard:null,selected:null,chart:null,searchTimer:null,fallbackHits:0,hsOnly:readStore("ashare.hsOnly",false),events:[],eventFilter:"all",strategyRows:[]
};
var $=function(s){return document.querySelector(s)};
var $$=function(s){return Array.from(document.querySelectorAll(s))};
function readStore(key,fallback){try{var x=localStorage.getItem(key);return x?JSON.parse(x):fallback}catch(e){return fallback}}
function saveStore(key,value){localStorage.setItem(key,JSON.stringify(value))}
function esc(v){return String(v===undefined||v===null?"":v).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function fmt(n,d){if(n===null||n===undefined||!isFinite(Number(n)))return"--";return Number(n).toFixed(d===undefined?2:d)}
function unit(n){n=Number(n);if(!isFinite(n))return"--";if(Math.abs(n)>=1e8)return fmt(n/1e8,2)+"亿";if(Math.abs(n)>=1e4)return fmt(n/1e4,1)+"万";return fmt(n,0)}
function pct(n){return(n>0?"+":"")+fmt(n,2)+"%"}
function color(n){return Number(n)>0?"up":Number(n)<0?"down":"flat"}
function mean(a){return a.length?a.reduce(function(x,y){return x+y},0)/a.length:0}
function marketId(code){return(/^(6|9)/.test(code)?"1.":"0.")+code}
function debounce(fn,ms){return function(){var args=arguments;clearTimeout(state.searchTimer);state.searchTimer=setTimeout(function(){fn.apply(null,args)},ms)}}
function toast(text){var el=$("#toast");el.textContent=text;el.classList.add("show");setTimeout(function(){el.classList.remove("show")},1800)}
function setSource(ok,text){$("#sourceDot").className="dot "+(ok?"ok":"bad");$("#sourceText").textContent=text}
var REQUEST_LIMIT=3,REQUEST_GAP=220,requestQueue=[],activeRequests=0,nextRequestAt=0;
function sleep(ms){return new Promise(function(resolve){setTimeout(resolve,ms)})}
function pumpQueue(){
  while(activeRequests<REQUEST_LIMIT&&requestQueue.length){
    var item=requestQueue.shift(),now=Date.now(),wait=Math.max(0,nextRequestAt-now);
    nextRequestAt=Math.max(nextRequestAt,now)+REQUEST_GAP;activeRequests++;
    (function(job,delay){setTimeout(function(){
      job.task().then(job.resolve,job.reject).finally(function(){activeRequests--;pumpQueue()});
    },delay)})(item,wait);
  }
}
function queued(task){return new Promise(function(resolve,reject){requestQueue.push({task:task,resolve:resolve,reject:reject});pumpQueue()})}
function rawJsonp(url,params,timeout){
  timeout=timeout||15000;return new Promise(function(resolve,reject){
    var cb="em_"+Date.now()+"_"+Math.random().toString(16).slice(2),script=document.createElement("script"),timer;
    params=Object.assign({},params||{},{cb:cb});
    var q=Object.keys(params).map(function(k){return encodeURIComponent(k)+"="+encodeURIComponent(params[k])}).join("&");
    function clean(){clearTimeout(timer);delete window[cb];script.remove()}
    window[cb]=function(data){clean();resolve(data)};
    script.onerror=function(){clean();reject(new Error("东方财富接口加载失败"))};
    timer=setTimeout(function(){clean();reject(new Error("东方财富接口超时"))},timeout);
    script.src=url+(url.indexOf("?")>-1?"&":"?")+q;script.referrerPolicy="no-referrer-when-downgrade";document.head.appendChild(script);
  });
}
function jsonp(url,params,timeout){
  return queued(async function(){
    var last;
    for(var attempt=0;attempt<3;attempt++){
      try{return await rawJsonp(url,params,timeout)}
      catch(e){last=e;if(attempt<2)await sleep(500*Math.pow(2,attempt))}
    }
    throw last;
  });
}
function clist(fs,pz,fid){
  return jsonp(API.list,{pn:1,pz:pz||20,po:1,np:1,fltt:2,invt:2,fid:fid||"f3",fs:fs,fields:"f2,f3,f5,f6,f8,f10,f12,f14,f15,f16,f17,f18,f20,f21,f62,f184"}).then(function(j){return j&&j.data&&j.data.diff?j.data.diff:[]});
}
function isHuShen(code){return/^[036]/.test(String(code))}
function symbol(code){return(/^(4|8|92)/.test(code)?"bj":/^(6|9)/.test(code)?"sh":"sz")+code}
function rawGlobalScript(url,globalName,timeout){
  timeout=timeout||15000;return new Promise(function(resolve,reject){
    var script=document.createElement("script"),timer;
    function clean(){clearTimeout(timer);script.remove()}
    script.onload=function(){var data=window[globalName];try{delete window[globalName]}catch(e){}clean();data!==undefined?resolve(data):reject(new Error("备用源返回为空"))};
    script.onerror=function(){clean();reject(new Error("备用行情接口加载失败"))};
    timer=setTimeout(function(){clean();reject(new Error("备用行情接口超时"))},timeout);
    script.src=url;script.referrerPolicy="no-referrer-when-downgrade";document.head.appendChild(script);
  });
}
function globalScript(url,globalName,timeout){
  return queued(async function(){var last;for(var i=0;i<2;i++){try{return await rawGlobalScript(url,globalName,timeout)}catch(e){last=e;if(i===0)await sleep(700)}}throw last});
}
function getEastmoneyQuote(code){
  return jsonp(API.quote,{secid:marketId(code),fltt:2,fields:"f43,f44,f45,f46,f47,f48,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170"}).then(function(j){var q=j&&j.data?j.data:{};q._source="东方财富";return q});
}
async function getTencentQuote(code){
  var s=symbol(code),raw=await globalScript(API.tencentQuote+s,"v_"+s),a=String(raw||"").split("~");
  if(a.length<10||!isFinite(+a[3]))throw new Error("腾讯行情无该股票数据");
  return{f58:a[1],f57:a[2],f43:+a[3],f60:+a[4],f46:+a[5],f47:+a[36]||+a[6],f48:(+a[37]||0)*10000,f170:+a[32],f169:+a[31],f44:+a[33],f45:+a[34],f168:+a[38],f162:+a[39],_source:"腾讯行情"};
}
async function getQuote(code){try{return await getTencentQuote(code)}catch(e){state.fallbackHits++;return getEastmoneyQuote(code)}}
function parseKRows(rows,source){
  var out=(rows||[]).map(function(a){if(typeof a==="string")a=a.split(",");return{date:a[0],open:+a[1],close:+a[2],high:+a[3],low:+a[4],volume:+a[5],amount:+a[6]||0,amplitude:+a[7]||0,pct:+a[8]||0,turnover:+a[10]||0}});
  out._source=source;return out;
}
function getEastmoneyK(code,klt,lmt){
  return jsonp(API.kline,{secid:marketId(code),klt:klt||101,fqt:1,lmt:lmt||120,end:20500101,fields1:"f1,f2,f3,f4,f5,f6",fields2:"f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"}).then(function(j){return parseKRows(j&&j.data&&j.data.klines?j.data.klines:[],"东方财富")});
}
async function getTencentK(code,klt,lmt){
  var s=symbol(code),period=String(klt||101)==="101"?"day":"m"+String(klt),key="tq_"+s+"_"+period+"_"+Date.now(),url=API.tencentK+"?_var="+key+"&param="+encodeURIComponent(s+","+period+",,,"+(lmt||120)+",qfq");
  var j=await globalScript(url,key),root=j&&j.data&&j.data[s]||{},rows=root["qfq"+period]||root[period]||root.day||[];
  if(!rows.length)throw new Error("腾讯K线数据为空");
  var out=parseKRows(rows,"腾讯行情");
  for(var i=0;i<out.length;i++){if(!out[i].pct&&i)out[i].pct=(out[i].close/out[i-1].close-1)*100}
  return out;
}
async function getK(code,klt,lmt){try{return await getTencentK(code,klt,lmt)}catch(e){state.fallbackHits++;var k=await getEastmoneyK(code,klt,lmt);if(!k.length)throw new Error("K线数据为空");return k}}
function getEastmoneyTrend(code){
  return jsonp(API.trend,{secid:marketId(code),ndays:1,iscr:0,iscca:0,fields1:"f1,f2,f3,f4,f5,f6,f7,f8",fields2:"f51,f52,f53,f54,f55,f56,f57,f58"}).then(function(j){var d=j&&j.data?j.data:{},rows=d.trends||[];return{preClose:+d.preClose,source:"东方财富",rows:rows.map(function(v){var a=v.split(",");return{time:a[0],price:+a[2],avg:+a[3],volume:+a[5],amount:+a[6]}})}});
}
async function getTencentTrend(code){
  var s=symbol(code),key="tm_"+s+"_"+Date.now(),j=await globalScript(API.tencentTrend+"?_var="+key+"&code="+s,key),root=j&&j.data&&j.data[s]||{},raw=root.data&&root.data.data||root.data||[];
  var totalVol=0,totalAmt=0,rows=(raw||[]).map(function(v){var a=String(v).split(" "),vol=+a[2]||0,amt=+a[3]||0;totalVol+=vol;totalAmt+=amt;return{time:(root.data&&root.data.date?root.data.date+" ":"")+a[0],price:+a[1],avg:totalVol?totalAmt/(totalVol*100):+a[1],volume:vol,amount:amt}});
  if(!rows.length)throw new Error("腾讯分时数据为空");
  return{preClose:+root.qt&&+root.qt[3]||0,source:"腾讯行情",rows:rows};
}
async function getTrend(code){try{return await getTencentTrend(code)}catch(e){state.fallbackHits++;var t=await getEastmoneyTrend(code);if(!t.rows.length)throw new Error("分时数据为空");return t}}
function rsi14(k){
  var gains=0,losses=0,rows=k.slice(-15);if(rows.length<15)return NaN;
  for(var i=1;i<rows.length;i++){var d=rows[i].close-rows[i-1].close;if(d>0)gains+=d;else losses-=d}
  if(!losses)return 100;var rs=(gains/14)/(losses/14);return 100-100/(1+rs);
}
function atrPct(k){
  var rows=k.slice(-15);if(rows.length<15)return NaN,tr=[];
  for(var i=1;i<rows.length;i++)tr.push(Math.max(rows[i].high-rows[i].low,Math.abs(rows[i].high-rows[i-1].close),Math.abs(rows[i].low-rows[i-1].close)));
  return mean(tr)/rows[rows.length-1].close*100;
}
function annualVol(k){
  var rows=k.slice(-21),rets=[];for(var i=1;i<rows.length;i++)rets.push(Math.log(rows[i].close/rows[i-1].close));
  if(rets.length<2)return NaN;var m=mean(rets),variance=mean(rets.map(function(x){return Math.pow(x-m,2)}));return Math.sqrt(variance)*Math.sqrt(252)*100;
}
function maxDrawdown(k){
  var peak=0,dd=0;k.slice(-60).forEach(function(x){peak=Math.max(peak,x.close);if(peak)dd=Math.min(dd,(x.close/peak-1)*100)});return dd;
}
function compute(meta,q,k){
  if(!k||k.length<31)return Object.assign({},meta,{name:q.f58||meta.name,price:q.f43,pct:q.f170,volume:q.f47,amount:q.f48,signal:"历史数据不足",score:0,k:k||[],quote:q,source:q._source||(k&&k._source)||"未知"});
  var last=k[k.length-1],prev=k[k.length-2],avg5=mean(k.slice(-6,-1).map(function(x){return x.volume})),ma=function(n){return mean(k.slice(-n).map(function(x){return x.close}))};
  var ma5=ma(5),ma10=ma(10),ma20=ma(20),ma30=ma(30),max20=Math.max.apply(null,k.slice(-21,-1).map(function(x){return x.high}));
  var price=isFinite(q.f43)?+q.f43:last.close,dayPct=isFinite(q.f170)?+q.f170:last.pct,volume=isFinite(q.f47)?+q.f47:last.volume,amount=isFinite(q.f48)?+q.f48:last.amount;
  var r10=(price/k[k.length-11].close-1)*100,r20=(price/k[k.length-21].close-1)*100,d10=(price/ma10-1)*100,d30=(price/ma30-1)*100,vr=avg5?volume/avg5:0,rsi=rsi14(k),atr=atrPct(k),vol20=annualVol(k),drawdown=maxDrawdown(k),high60=Math.max.apply(null,k.slice(-60).map(function(x){return x.high})),signal="趋势观察",score=45;
  if(price>max20&&vr>1.5){signal="放量突破";score=88}
  else if(price>=ma20*.98&&price<=ma20*1.04&&vr<.82&&r20>4){signal="缩量回踩";score=82}
  else if(dayPct>2&&prev.pct<0&&vr>1.05){signal="弱转强";score=78}
  else if(Math.abs(dayPct)<2&&vr>1.8&&r20>15){signal="放量滞涨";score=30}
  if(ma5>ma10&&ma10>ma20)score+=7;if(dayPct>0)score+=3;if(r20>35)score-=10;if(d10>12)score-=8;
  return Object.assign({},meta,{name:q.f58||meta.name,price:price,pct:dayPct,volume:volume,amount:amount,avg3:mean(k.slice(-3).map(function(x){return x.volume})),r10:r10,r20:r20,d10:d10,d30:d30,vr:vr,ma5:ma5,ma10:ma10,ma20:ma20,signal:signal,score:Math.max(0,Math.min(99,score)),k:k,quote:q,source:q._source||k._source||"未知",rsi14:rsi,atrPct:atr,vol20:vol20,maxDrawdown60:drawdown,high60Distance:(price/high60-1)*100,prevPct:prev.pct});
}
async function analyze(meta){
  var pair=await Promise.all([getQuote(meta.code),getK(meta.code,101,100)]);
  return compute(meta,pair[0],pair[1]);
}
function isWatched(code){return state.watch.some(function(x){return x.code===code})}
function toggleWatch(meta){
  var i=state.watch.findIndex(function(x){return x.code===meta.code});
  if(i>-1){state.watch.splice(i,1);toast("已从自选删除")}
  else{state.watch.unshift({code:meta.code,name:meta.name||meta.code});toast("已加入自选")}
  saveStore("ashare.watch",state.watch);syncWatchButtons();renderWatch();
}
function syncWatchButtons(){
  $$("[data-watch]").forEach(function(b){var yes=isWatched(b.dataset.watch);b.classList.toggle("starred",yes);b.textContent=yes?"★":"☆";b.title=yes?"删除自选":"加入自选"});
  if(state.selected){var b=$("#detailWatch");var yes=isWatched(state.selected.code);b.classList.toggle("starred",yes);b.textContent=yes?"★ 已自选":"☆ 加自选"}
}
async function loadIndices(){
  var defs=[["上证指数","000001"],["深证成指","399001"],["创业板指","399006"]];
  var rows=await Promise.all(defs.map(async function(x){try{return[x[0],await getQuote(x[1])]}catch(e){return[x[0],null]}}));
  $("#indices").innerHTML=rows.map(function(x){var q=x[1];return'<div class="card index"><span class="label">'+x[0]+'</span><div class="value '+(q?color(q.f170):"")+'">'+(q?fmt(q.f43):"--")+'</div><span class="delta '+(q?color(q.f170):"flat")+'">'+(q?pct(q.f170):"接口不可用")+'</span></div>'}).join("")+'<div class="card index"><span class="label">热门板块</span><div class="value">'+state.hot.length+'</div><span class="delta flat">动态跟踪</span></div>';
}
async function loadBoards(){
  var both=await Promise.all([clist("m:90+t:2",500,"f3"),clist("m:90+t:3",500,"f3")]);
  var seen={};state.boards=both[0].concat(both[1]).filter(function(x){if(!x.f12||seen[x.f14])return false;seen[x.f14]=1;return true});
  state.hot=state.boards.filter(function(x){return isFinite(x.f3)&&!META_BOARD.test(x.f14)}).sort(function(a,b){return b.f3-a.f3}).slice(0,5).map(function(x){return{label:x.f14,name:x.f14,code:x.f12,pct:x.f3}});
  if(!state.fixed){
    state.fixed=DEFAULT_SECTORS.map(function(d){var match=findBoard(d.aliases);return{label:d.label,name:match?match.f14:d.label,code:match?match.f12:""}});
    saveStore("ashare.fixed",state.fixed);
  }else{
    state.fixed=state.fixed.map(function(x){if(x.code)return x;var m=findBoard([x.label||x.name]);return Object.assign({},x,{code:m?m.f12:"",name:m?m.f14:(x.name||x.label)})});
  }
  renderSectors();loadIndices();
  if(!state.activeBoard&&state.hot[0])selectBoard(state.hot[0]);
}
function findBoard(names){
  var exact=null,partial=null;
  names.some(function(n){exact=state.boards.find(function(b){return b.f14===n});return!!exact});
  if(exact)return exact;
  names.some(function(n){partial=state.boards.find(function(b){return b.f14.indexOf(n)>-1||n.indexOf(b.f14)>-1});return!!partial});
  return partial;
}
function renderSectors(){
  $("#hotSectors").innerHTML=state.hot.length?state.hot.map(function(x){return'<button class="chip hot '+(state.activeBoard&&state.activeBoard.code===x.code?"active":"")+'" data-board="'+esc(x.code)+'">'+esc(x.label)+' '+pct(x.pct)+'</button>'}).join(""):'<span class="help">暂无热门板块数据</span>';
  $("#fixedSectors").innerHTML=state.fixed.map(function(x,i){return'<span class="chip '+(state.activeBoard&&state.activeBoard.code===x.code?"active":"")+'"><button class="chip-main" data-fixed="'+i+'" '+(x.code?"":"disabled")+'>'+esc(x.label)+'</button><button class="chip-x" data-delete-sector="'+i+'" title="删除板块">×</button></span>'}).join("");
  $$("[data-board]").forEach(function(b){b.onclick=function(){selectBoard(state.hot.find(function(x){return x.code===b.dataset.board}))}});
  $$("[data-fixed]").forEach(function(b){b.onclick=function(){selectBoard(state.fixed[+b.dataset.fixed])}});
  $$("[data-delete-sector]").forEach(function(b){b.onclick=function(e){e.stopPropagation();state.fixed.splice(+b.dataset.deleteSector,1);saveStore("ashare.fixed",state.fixed);renderSectors()}});
}
async function addSector(){
  var input=$("#sectorInput"),name=input.value.trim();if(!name)return;
  var b=findBoard([name]);
  if(!b){toast("未找到该板块，请输入东方财富板块名称");return}
  if(state.fixed.some(function(x){return x.code===b.f12})){toast("该板块已经在关注池");return}
  state.fixed.push({label:name,name:b.f14,code:b.f12});saveStore("ashare.fixed",state.fixed);input.value="";renderSectors();selectBoard(state.fixed[state.fixed.length-1]);toast("已添加板块");
}
async function selectBoard(board){
  if(!board||!board.code){toast("板块代码尚未匹配");return}
  switchView("market");state.activeBoard=board;renderSectors();$("#candidateTitle").textContent=(board.label||board.name)+" · 推荐观察";
  $("#candidateSub").textContent="正在读取板块成分股并计算量价结构";$("#candidateRows").innerHTML='<tr><td colspan="12" class="empty">正在分析板块成分股...</td></tr>';
  try{
    var members=await clist("b:"+board.code,18,"f3");members=members.filter(function(x){return/^\d{6}$/.test(x.f12)&&(!state.hsOnly||isHuShen(x.f12))}).slice(0,8);
    var rows=await Promise.all(members.map(async function(x){try{return await analyze({code:x.f12,name:x.f14,sector:board.label||board.name})}catch(e){return null}}));
    state.candidates=rows.filter(Boolean).sort(function(a,b){return b.score-a.score}).slice(0,5);
    $("#candidateSub").textContent="按结构评分列出 3–5 只，点击“详情”查看分时、K线和公告";renderTable("#candidateRows",state.candidates,false);buildReport();
  }catch(e){var cached=snapshotForBoard(board);state.candidates=cached;if(cached.length){$("#candidateSub").textContent="实时接口限流，当前显示定时快照";renderTable("#candidateRows",cached,false)}else{$("#candidateRows").innerHTML='<tr><td colspan="12" class="empty">板块数据读取失败：'+esc(e.message)+'</td></tr>'}}
}
function tagClass(s){return s==="放量突破"||s==="缩量回踩"?"good":s==="放量滞涨"?"risk":"warn"}
function renderTable(selector,rows,isWatch){
  var body=$(selector);rows=state.hsOnly?rows.filter(function(x){return isHuShen(x.code)}):rows;
  if(!rows.length){body.innerHTML='<tr><td colspan="12" class="empty">'+(isWatch?'还没有自选股。请到“股市”搜索股票并点击 ☆ 加入自选。':'暂无可展示的推荐股')+'</td></tr>';return}
  body.innerHTML=rows.map(function(x){return'<tr><td><span class="name">'+esc(x.name)+'</span><br><span class="code">'+x.code+'</span></td><td><span class="code">'+esc(x.sector||"--")+'</span><br><span class="tag '+tagClass(x.signal)+'">'+esc(x.signal)+'</span></td><td>'+fmt(x.price)+'</td><td class="'+color(x.pct)+'">'+pct(x.pct)+'</td><td>'+unit(x.volume)+'</td><td>'+unit(x.amount)+'</td><td>'+unit(x.avg3)+'</td><td class="'+color(x.r10)+'">'+pct(x.r10)+'</td><td class="'+color(x.r20)+'">'+pct(x.r20)+'</td><td>'+fmt(x.d10,1)+'% / '+fmt(x.d30,1)+'%</td><td class="score">'+x.score+'</td><td><div class="row-actions"><button class="btn small" data-detail="'+x.code+'">详情</button><button class="icon-btn '+(isWatched(x.code)?"starred":"")+'" data-watch="'+x.code+'" title="'+(isWatched(x.code)?"删除自选":"加入自选")+'">'+(isWatched(x.code)?"★":"☆")+'</button>'+(isWatch?'<button class="icon-btn danger" data-remove="'+x.code+'" title="删除自选">×</button>':'')+'</div></td></tr>'}).join("");
  body.querySelectorAll("[data-detail]").forEach(function(b){b.onclick=function(){var x=rows.find(function(r){return r.code===b.dataset.detail});openDetail(x)}});
  body.querySelectorAll("[data-watch]").forEach(function(b){b.onclick=function(){var x=rows.find(function(r){return r.code===b.dataset.watch});toggleWatch(x)}});
  body.querySelectorAll("[data-remove]").forEach(function(b){b.onclick=function(){var x=rows.find(function(r){return r.code===b.dataset.remove});toggleWatch(x)}});
}
async function renderWatch(){
  $("#watchCount").textContent=state.watch.length;
  if(!state.watch.length){state.watchRows=[];renderTable("#watchRows",[],true);updateWatchSummary();return}
  $("#watchRows").innerHTML='<tr><td colspan="12" class="empty">正在更新自选行情...</td></tr>';
  var rows=await Promise.all(state.watch.map(async function(x){try{return await analyze({code:x.code,name:x.name,sector:"自选"})}catch(e){return Object.assign({},x,{sector:"自选",signal:"接口不可用",score:0})}}));
  state.watchRows=rows;renderTable("#watchRows",rows,true);updateWatchSummary();
}
function updateWatchSummary(){
  var valid=state.watchRows.filter(function(x){return isFinite(x.pct)}),up=valid.filter(function(x){return x.pct>0}).length,avg=valid.length?mean(valid.map(function(x){return x.pct})):0;
  $("#watchUp").textContent=up;$("#watchAvg").textContent=valid.length?pct(avg):"--";$("#watchAvg").className=color(avg);
}
async function loadUniverse(){
  if(state.universe)return state.universe;
  var both=await Promise.all([clist("m:0+t:6,m:0+t:80",6000,"f12"),clist("m:1+t:2,m:1+t:23",3000,"f12")]);
  var seen={};state.universe=both[0].concat(both[1]).filter(function(x){if(!/^\d{6}$/.test(x.f12)||seen[x.f12])return false;seen[x.f12]=1;return true}).map(function(x){return{code:x.f12,name:x.f14,price:x.f2,pct:x.f3,quoteId:marketId(x.f12)}});
  return state.universe;
}
async function suggestTencent(q){
  var raw=await globalScript(API.tencentSearch+"?q="+encodeURIComponent(q)+"&t=all&v=2","v_hint"),parts=String(raw||"").split("^");
  return parts.map(function(v){var a=v.split("~");return{market:a[0],code:a[1],name:a[2],type:a[4]}}).filter(function(x){return/^\d{6}$/.test(x.code)&&(x.market==="sh"||x.market==="sz"||x.market==="bj")}).slice(0,10);
}
async function suggest(q){
  var list=[];
  try{list=await suggestTencent(q)}catch(e){}
  if(!list.length){try{
    var url=API.suggest+"?input="+encodeURIComponent(q)+"&type=14&token=D43BF722C8E33CBD6D1FBCBF5A2D9D0E&count=12";
    var res=await fetch(url),j=await res.json(),d=j&&j.QuotationCodeTable&&j.QuotationCodeTable.Data||[];
    list=d.filter(function(x){return/^\d{6}$/.test(x.Code)}).map(function(x){return{code:x.Code,name:x.Name,quoteId:x.QuoteID||marketId(x.Code)}}).slice(0,10);
  }catch(e){}}
  if(!list.length){
    var all=await loadUniverse(),needle=q.toLowerCase();
    list=all.filter(function(x){return x.code.indexOf(needle)>-1||x.name.toLowerCase().indexOf(needle)>-1}).slice(0,10);
  }
  var withQuote=await Promise.all(list.map(async function(x){try{var z=await getQuote(x.code);return Object.assign({},x,{name:z.f58||x.name,price:z.f43,pct:z.f170})}catch(e){return x}}));
  return withQuote;
}
async function runSearch(q){
  q=q.trim();if(q.length<1){hideSearch();return}
  var box=$("#searchResults");box.classList.remove("hidden");box.innerHTML='<div class="empty">正在搜索全部 A 股...</div>';
  try{state.searchRows=await suggest(q);renderSearch()}catch(e){box.innerHTML='<div class="empty">搜索接口暂时不可用：'+esc(e.message)+'</div>'}
}
function renderSearch(){
  var box=$("#searchResults");state.searchRows=state.hsOnly?state.searchRows.filter(function(x){return isHuShen(x.code)}):state.searchRows;
  if(!state.searchRows.length){box.innerHTML='<div class="empty">没有找到匹配的 A 股</div>';return}
  box.innerHTML=state.searchRows.map(function(x){return'<div class="search-item"><div><span class="search-name">'+esc(x.name)+'</span><br><span class="code">'+x.code+'</span></div><div class="quote-cell">'+fmt(x.price)+'</div><div class="quote-cell '+color(x.pct)+'">'+(isFinite(x.pct)?pct(x.pct):"--")+'</div><div class="search-actions"><button class="btn small" data-search-detail="'+x.code+'">详情</button><button class="icon-btn '+(isWatched(x.code)?"starred":"")+'" data-search-watch="'+x.code+'">'+(isWatched(x.code)?"★":"☆")+'</button></div></div>'}).join("");
  box.querySelectorAll("[data-search-detail]").forEach(function(b){b.onclick=function(){var x=state.searchRows.find(function(r){return r.code===b.dataset.searchDetail});hideSearch();openDetail(x)}});
  box.querySelectorAll("[data-search-watch]").forEach(function(b){b.onclick=function(){var x=state.searchRows.find(function(r){return r.code===b.dataset.searchWatch});toggleWatch(x);renderSearch()}});
}
function hideSearch(){var b=$("#searchResults");b.classList.add("hidden");b.innerHTML=""}
async function openDetail(meta){
  $("#detail").showModal();$("#detailName").textContent=meta.name||meta.code;$("#detailCode").textContent=meta.code;$("#detailPrice").textContent="读取中";$("#metrics").innerHTML='<div class="metric skeleton"><span class="label">读取行情</span><b>--</b></div>';$("#chart").innerHTML='<div class="chart-status">正在加载分时数据...</div>';$("#professionalFactors").innerHTML="";$("#announcements").innerHTML='<div class="help">正在读取近期公告...</div>';
  try{
    var x=meta.k&&meta.k.length?meta:await analyze({code:meta.code,name:meta.name,sector:meta.sector||"全市场"});
    state.selected=x;$("#detailName").textContent=x.name;$("#detailCode").textContent=x.code+" · "+(x.sector||"全市场");$("#detailPrice").textContent=fmt(x.price);$("#detailPrice").className="modal-price "+color(x.pct);
    $("#metrics").innerHTML=metric("涨幅",pct(x.pct),color(x.pct))+metric("成交额",unit(x.amount))+metric("换手率",fmt(x.quote.f168,2)+"%")+metric("量比",fmt(x.vr,2))+metric("10日涨幅",pct(x.r10),color(x.r10))+metric("20日涨幅",pct(x.r20),color(x.r20))+metric("市盈率",fmt(x.quote.f162,2))+metric("数据源",esc(x.source||"缓存快照"));$("#professionalFactors").innerHTML=factor("RSI14",fmt(x.rsi14,1),x.rsi14>70?"偏热":x.rsi14<30?"超跌区":"中性")+factor("ATR14",fmt(x.atrPct,2)+"%","日内真实波幅")+factor("20日波动",fmt(x.vol20,1)+"%","年化估算")+factor("60日回撤",fmt(x.maxDrawdown60,1)+"%","峰值至低点")+factor("距60日高点",fmt(x.high60Distance,1)+"%","位置指标")+factor("MA20偏离",fmt((x.price/x.ma20-1)*100,1)+"%","趋势距离");
    syncWatchButtons();selectChart("trend");loadAnnouncements(x);
  }catch(e){if(isFinite(meta.price)){state.selected=meta;$("#detailPrice").textContent=fmt(meta.price);$("#metrics").innerHTML=metric("涨幅",pct(meta.pct),color(meta.pct))+metric("成交额",unit(meta.amount))+metric("数据源","定时快照");$("#chart").innerHTML='<div class="chart-status">实时K线源均不可用，已保留快照指标。</div>';loadAnnouncements(meta)}else{$("#metrics").innerHTML='<div class="empty">详情读取失败：'+esc(e.message)+'</div>';$("#chart").innerHTML=""}}
}
function metric(label,value,c){return'<div class="metric"><span class="label">'+label+'</span><b class="'+(c||"")+'">'+value+'</b></div>'}
function factor(label,value,note){return'<div class="factor"><span class="label">'+label+'</span><b>'+value+'</b><span class="metric-note">'+note+'</span></div>'}
function resetChart(){
  if(state.chart){state.chart.dispose();state.chart=null}
  $("#chart").innerHTML="";
  if(!window.echarts){$("#chart").innerHTML='<div class="chart-status">图表组件加载失败，请检查 CDN 网络。</div>';return false}
  state.chart=echarts.init($("#chart"));return true
}
async function selectChart(mode){
  $$(".period").forEach(function(b){b.classList.toggle("active",b.dataset.chart===mode)});
  $("#chart").innerHTML='<div class="chart-status">正在加载图表...</div>';
  try{
    if(mode==="trend"){var t=await getTrend(state.selected.code);drawTrend(t)}
    else{var k=mode==="101"?state.selected.k:await getK(state.selected.code,+mode,240);drawK(k)}
  }catch(e){$("#chart").innerHTML='<div class="chart-status">图表数据读取失败：'+esc(e.message)+'</div>'}
}
function drawTrend(t){
  if(!resetChart())return;var rows=t.rows,base=t.preClose||rows[0]&&rows[0].price||1;
  state.chart.setOption({animation:false,backgroundColor:"transparent",tooltip:{trigger:"axis"},legend:{data:["现价","均价"],textStyle:{color:"#8fa7ba"}},grid:{left:58,right:58,top:38,bottom:40},xAxis:{type:"category",boundaryGap:false,data:rows.map(function(x){return x.time.slice(11)}),axisLine:{lineStyle:{color:"#355064"}},axisLabel:{color:"#8fa7ba",interval:30}},yAxis:[{scale:true,splitLine:{lineStyle:{color:"#172b3a"}},axisLabel:{color:"#8fa7ba"}},{scale:true,splitLine:{show:false},axisLabel:{color:"#8fa7ba",formatter:function(v){return fmt((v/base-1)*100,1)+"%"}}}],series:[{name:"现价",type:"line",showSymbol:false,data:rows.map(function(x){return x.price}),lineStyle:{color:"#4aa8ff",width:2},areaStyle:{color:"rgba(74,168,255,.12)"}},{name:"均价",type:"line",showSymbol:false,data:rows.map(function(x){return x.avg}),lineStyle:{color:"#f6bd58",width:1}}]});
}
function maSeries(k,n){return k.map(function(_,i){if(i<n-1)return"-";return fmt(mean(k.slice(i-n+1,i+1).map(function(x){return x.close})),2)})}
function drawK(k){
  if(!resetChart())return;var dates=k.map(function(x){return x.date}),values=k.map(function(x){return[x.open,x.close,x.low,x.high]}),vol=k.map(function(x){return{value:x.volume,itemStyle:{color:x.close>=x.open?"#ff5573":"#27d6a1"}}});
  state.chart.setOption({animation:false,backgroundColor:"transparent",legend:{data:["K线","MA5","MA10","MA20"],textStyle:{color:"#8fa7ba"}},tooltip:{trigger:"axis",axisPointer:{type:"cross"}},axisPointer:{link:[{xAxisIndex:"all"}]},grid:[{left:52,right:24,top:36,height:"60%"},{left:52,right:24,top:"76%",height:"14%"}],xAxis:[{type:"category",data:dates,boundaryGap:false,axisLine:{lineStyle:{color:"#355064"}},axisLabel:{color:"#8fa7ba"}},{type:"category",gridIndex:1,data:dates,boundaryGap:false,axisLabel:{show:false},axisLine:{lineStyle:{color:"#355064"}}}],yAxis:[{scale:true,splitLine:{lineStyle:{color:"#172b3a"}},axisLabel:{color:"#8fa7ba"}},{gridIndex:1,scale:true,splitNumber:2,splitLine:{show:false},axisLabel:{color:"#8fa7ba",formatter:unit}}],dataZoom:[{type:"inside",xAxisIndex:[0,1],start:42,end:100},{show:true,type:"slider",xAxisIndex:[0,1],bottom:2,height:18,borderColor:"#203345",fillerColor:"rgba(74,168,255,.16)",textStyle:{color:"#8fa7ba"}}],series:[{name:"K线",type:"candlestick",data:values,itemStyle:{color:"#ff5573",color0:"#27d6a1",borderColor:"#ff5573",borderColor0:"#27d6a1"}},{name:"MA5",type:"line",data:maSeries(k,5),symbol:"none",lineStyle:{width:1,color:"#f6bd58"}},{name:"MA10",type:"line",data:maSeries(k,10),symbol:"none",lineStyle:{width:1,color:"#4aa8ff"}},{name:"MA20",type:"line",data:maSeries(k,20),symbol:"none",lineStyle:{width:1,color:"#bd83ff"}},{name:"成交量",type:"bar",xAxisIndex:1,yAxisIndex:1,data:vol}]});
}
async function loadAnnouncements(x){
  var box=$("#announcements"),pos=/增持|回购|中标|预增|扭亏|分红|签订|获批|突破/,neg=/减持|亏损|处罚|立案|诉讼|终止|退市|风险|质押/;
  try{
    var res=await fetch(API.ann+"?sr=-1&page_size=10&page_index=1&ann_type=A&client_source=web&stock_list="+x.code),j=await res.json(),rows=j&&j.data&&j.data.list||[];
    if(!rows.length)throw new Error("暂无公告");
    box.innerHTML=rows.map(function(a){var title=a.title||"公告",kind=neg.test(title)?"risk":pos.test(title)?"good":"warn",label=kind==="risk"?"偏利空词":kind==="good"?"偏利好词":"中性/待核实";return'<a class="ann" target="_blank" rel="noopener" href="https://data.eastmoney.com/notices/stock/'+x.code+'.html"><span class="ann-title">'+esc(title)+'</span><span class="tag '+kind+'">'+label+'</span></a>'}).join("");
  }catch(e){var snap=state.snapshot&&state.snapshot.candidates&&state.snapshot.candidates.find(function(v){return v.code===x.code}),cached=snap&&snap.announcements||[];if(cached.length){box.innerHTML=cached.map(function(a){var kind=a.tone==="偏利空"?"risk":a.tone==="偏利好"?"good":"warn";return'<div class="ann"><span class="ann-title">'+esc(a.title)+'</span><span class="tag '+kind+'">'+esc(a.tone)+' · 快照</span></div>'}).join("")}else{box.innerHTML='<div class="help">实时公告源不可用且无缓存。<a class="up" target="_blank" rel="noopener" href="https://www.cninfo.com.cn/new/disclosure/stock?stockCode='+x.code+'">前往巨潮资讯核验</a></div>'}}
}
async function loadSnapshot(){
  try{
    var res=await fetch("./data/latest.json?v="+Date.now(),{cache:"no-store"});
    if(!res.ok)throw new Error("快照不存在");
    var j=await res.json();state.snapshot=j;
    if(!state.hot.length)state.hot=(j.hot_sectors||[]).filter(function(x){return!META_BOARD.test(x.name)}).map(function(x){return{label:x.name,name:x.name,code:x.code,pct:x.pct}});
    var rows=(j.candidates||[]).map(function(x){return{code:x.code,name:x.name,sector:x.sector,price:x.price,pct:x.pct,volume:x.volume,amount:x.amount,avg3:x.avg3_volume,r10:x.return_10d,r20:x.return_20d,d10:x.deviation_10d,d30:x.deviation_30d,vr:x.volume_ratio,signal:x.signal,score:x.score,k:[],quote:{},source:"定时快照"}});
    if(rows.length&&!state.candidates.length){state.candidates=rows.slice(0,5);$("#candidateTitle").textContent="最新定时快照";$("#candidateSub").textContent="实时接口尚未完成时先展示 "+new Date(j.generated_at).toLocaleString("zh-CN")+" 的缓存数据";renderTable("#candidateRows",state.candidates,false)}
    renderSectors();return j;
  }catch(e){return null}
}
function snapshotForBoard(board){
  if(!state.snapshot)return[];
  var rows=(state.snapshot.candidates||[]).filter(function(x){return x.sector===(board.name||board.label)||x.sector===board.label}).map(function(x){return{code:x.code,name:x.name,sector:x.sector,price:x.price,pct:x.pct,volume:x.volume,amount:x.amount,avg3:x.avg3_volume,r10:x.return_10d,r20:x.return_20d,d10:x.deviation_10d,d30:x.deviation_30d,vr:x.volume_ratio,signal:x.signal,score:x.score,k:[],quote:{},source:"定时快照"}});
  return rows.slice(0,5);
}
var STRATEGIES={
  breakout:{name:"趋势突破",test:function(x){return x.signal==="放量突破"&&x.d10<12&&x.r20<35}},
  pullback:{name:"缩量回踩",test:function(x){return x.signal==="缩量回踩"&&x.rsi14>38&&x.rsi14<72}},
  reversal:{name:"弱转强",test:function(x){return x.pct>2&&x.prevPct<0&&x.vr>1}},
  lowvol:{name:"低波动趋势",test:function(x){return x.ma5>x.ma10&&x.ma10>x.ma20&&x.r20>3&&x.r20<25&&x.vol20<42&&x.d10>0&&x.d10<9}},
  oversold:{name:"超跌修复",test:function(x){return x.rsi14<38&&x.pct>0&&x.r20<0}}
};
function setHsOnly(value){
  state.hsOnly=value;saveStore("ashare.hsOnly",value);
  ["#hsOnlyToggle","#strategyHsToggle"].forEach(function(id){var b=$(id);if(b){b.classList.toggle("active",value);b.textContent=value?"✓ 只显示沪深":"只显示沪深"}});
  renderTable("#candidateRows",state.candidates,false);renderTable("#watchRows",state.watchRows,true);if(state.strategyRows.length)renderTable("#strategyRows",state.strategyRows,false);if($("#globalSearch").value)runSearch($("#globalSearch").value);
}
async function runStrategy(key){
  var rule=STRATEGIES[key];if(!rule)return;switchView("strategy");$("#strategyTitle").textContent=rule.name+" · 筛选结果";$("#strategyRows").innerHTML='<tr><td colspan="12" class="empty">正在建立活跃股票池...</td></tr>';
  $("[data-strategy]").forEach(function(b){b.disabled=true});var progress=$("#strategyProgress");
  try{
    var market=[];try{market=await clist("m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",50,"f6")}catch(sourceError){market=(state.snapshot&&state.snapshot.candidates||[]).map(function(x){return{f12:x.code,f14:x.name}})}var seen={},pool=[];
    market.concat(state.candidates).concat(state.watch).forEach(function(x){var code=x.f12||x.code,name=x.f14||x.name;if(!/^\d{6}$/.test(code)||seen[code]||(state.hsOnly&&!isHuShen(code)))return;seen[code]=1;pool.push({code:code,name:name,sector:"策略池"})});
    pool=pool.slice(0,30);var done=0;
    var rows=await Promise.all(pool.map(async function(x){try{return await analyze(x)}catch(e){return null}finally{done++;progress.innerHTML="正在应用 <b>"+esc(rule.name)+"</b>："+done+" / "+pool.length}}));
    rows=rows.filter(Boolean);state.strategyRows=rows.filter(rule.test).sort(function(a,b){return b.score-a.score}).slice(0,20);
    progress.innerHTML="已扫描 <b>"+rows.length+"</b> 只成交活跃股票，找到 <b>"+state.strategyRows.length+"</b> 只完全符合条件的股票。";
    renderTable("#strategyRows",state.strategyRows,false);
  }catch(e){progress.textContent="策略运行失败："+e.message;$("#strategyRows").innerHTML='<tr><td colspan="12" class="empty">未取得可用策略数据</td></tr>'}
  finally{$("[data-strategy]").forEach(function(b){b.disabled=false})}
}
async function loadEvents(){
  try{var res=await fetch("./data/events.json?v="+Date.now(),{cache:"no-store"});if(!res.ok)throw new Error();var j=await res.json();state.events=j.events||[];renderEvents()}
  catch(e){$("#eventTimeline").innerHTML='<div class="empty">新闻快照尚未生成。可前往 <a href="https://www.news.cn/" target="_blank" rel="noopener">新华网</a> 查看国内外要闻。</div>'}
}
function renderEvents(){
  var rows=state.events.filter(function(x){return state.eventFilter==="all"||x.category===state.eventFilter}),groups={};
  rows.forEach(function(x){(groups[x.date]||(groups[x.date]=[])).push(x)});
  var dates=Object.keys(groups).sort().reverse();
  $("#eventTimeline").innerHTML=dates.length?dates.map(function(d){return'<section class="event-day"><div class="event-date">'+esc(d)+'</div><div class="event-list">'+groups[d].map(function(x){return'<div class="event-item"><span class="event-time">'+esc(x.time||"")+'</span><a class="event-title" href="'+esc(x.link)+'" target="_blank" rel="noopener">'+esc(x.title)+'</a><span class="event-source">'+esc(x.category)+" · "+esc(x.source||"新华网")+'</span></div>'}).join("")+'</div></section>'}).join(""):'<div class="empty">当前分类暂无新闻</div>';
}
function buildReport(){
  var best=state.candidates.slice().sort(function(a,b){return b.score-a.score}),risk=best.filter(function(x){return x.signal==="放量滞涨"||x.d10>12});
  $("#reportTime").textContent="数据时间："+new Date().toLocaleString("zh-CN",{hour12:false});
  $("#reportContent").innerHTML='<h3>热门板块</h3><p>'+state.hot.map(function(x){return esc(x.name)+" "+pct(x.pct)}).join("；")+'</p><h3>当前板块候选</h3><p>'+(best.length?best.map(function(x){return esc(x.name)+"（"+esc(x.signal)+"，"+x.score+"分）"}).join("；"):"尚未选择板块")+'</p><h3>风险观察</h3><p>'+(risk.length?risk.map(function(x){return esc(x.name)+"（"+esc(x.signal)+"）"}).join("；"):"当前列表未识别到典型放量滞涨，仍需结合位置和公告判断。")+'</p>';
}
function switchView(id){
  $$(".tab").forEach(function(x){x.classList.toggle("active",x.dataset.view===id)});$$(".view").forEach(function(x){x.classList.toggle("active",x.id===id)});
  if(id==="watch")renderWatch();if(id==="events"&&!state.events.length)loadEvents();
}
async function refresh(){
  $("#refreshBtn").disabled=true;$("#sourceDot").className="dot";$("#sourceText").textContent="正在连接腾讯财经";
  state.fallbackHits=0;
  try{await Promise.all([loadIndices(),loadBoards()]);setSource(true,(state.fallbackHits?"腾讯财经 + 东方财富容灾":"腾讯财经")+" · "+new Date().toLocaleTimeString("zh-CN",{hour12:false}));if($("#watch").classList.contains("active"))renderWatch()}
  catch(e){if(state.snapshot){setSource(false,"实时接口限流 · 当前显示定时快照");toast("实时请求受限，已切换到缓存快照")}else{setSource(false,"行情接口不可用，未使用模拟数据");toast(e.message)}}
  finally{$("#refreshBtn").disabled=false}
}
$$(".tab").forEach(function(b){b.onclick=function(){switchView(b.dataset.view)}});
$("#refreshBtn").onclick=refresh;$("#hsOnlyToggle").onclick=function(){setHsOnly(!state.hsOnly)};$("#strategyHsToggle").onclick=function(){setHsOnly(!state.hsOnly)};$("#addSector").onclick=addSector;$("#sectorInput").onkeydown=function(e){if(e.key==="Enter")addSector()};
$("#globalSearch").oninput=debounce(function(e){runSearch(e.target.value)},320);$("#globalSearchBtn").onclick=function(){runSearch($("#globalSearch").value)};
document.addEventListener("click",function(e){if(!e.target.closest(".market-search"))hideSearch()});
$("#detailClose").onclick=function(){$("#detail").close()};$("#detailWatch").onclick=function(){if(state.selected)toggleWatch(state.selected)};
$(".period").forEach(function(b){b.onclick=function(){if(state.selected)selectChart(b.dataset.chart)}});$("[data-strategy]").forEach(function(b){b.onclick=function(){runStrategy(b.dataset.strategy)}});$("[data-event-filter]").forEach(function(b){b.onclick=function(){$("[data-event-filter]").forEach(function(x){x.classList.toggle("active",x===b)});state.eventFilter=b.dataset.eventFilter;renderEvents()}});
window.addEventListener("resize",function(){if(state.chart)state.chart.resize()});
setHsOnly(state.hsOnly);loadEvents();loadSnapshot().finally(function(){refresh()});setInterval(refresh,300000);
})();