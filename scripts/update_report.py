#!/usr/bin/env python3
import json, os, re, time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

BASE="https://push2.eastmoney.com/api/qt/clist/get"
KBASE="https://push2his.eastmoney.com/api/qt/stock/kline/get"
QBASE="https://push2.eastmoney.com/api/qt/stock/get"
TENCENT_QUOTE="https://qt.gtimg.cn/q="
TENCENT_K="https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
HEADERS={"User-Agent":"Mozilla/5.0"}
POS=re.compile(r"增持|回购|中标|预增|扭亏|分红|签订|获批|突破")
NEG=re.compile(r"减持|亏损|处罚|立案|诉讼|终止|退市|风险|质押")
FIXED_SECTORS=[
    ("PCB",["PCB","印制电路板"]),("半导体",["半导体"]),("光纤",["光纤","光通信"]),
    ("贵金属",["贵金属","黄金"]),("小金属",["小金属"]),("化工",["化工","化学制品"]),
    ("油气",["油气开采","油气"]),("粮食",["粮食概念","种植业"]),("MLCC",["MLCC","被动元件"])
]
META_BOARD=re.compile(r"昨日|涨停|连板|ST|预盈|融资融券|深股通|沪股通|百元股|机构重仓|基金重仓|MSCI|标准普尔|证金持股|AH股|次新股|破净股|低价股|高送转|转债标的")
DOMESTIC_EVENT=re.compile(r"国务院|中央|央行|人民银行|证监会|财政部|发改委|统计局|政策|利率|降准|降息|GDP|CPI|关税|贸易|经济|科技|人工智能|能源|地震|台风|洪水|事故|外交")
GLOBAL_EVENT=re.compile(r"战争|冲突|停火|制裁|关税|贸易|选举|总统|央行|利率|联合国|峰会|地震|飓风|石油|黄金|能源|人工智能|AI|芯片|核|外交|经济")
EVENT_EXCLUDE=re.compile(r"重大资产重组|复牌|开学典礼|招聘|校招|股价异动|涨停")

def get(url, params):
    last_error=None
    for attempt in range(4):
        try:
            req=Request(url+"?"+urlencode(params),headers=HEADERS)
            with urlopen(req,timeout=25) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as exc:
            last_error=exc
            time.sleep(2 ** attempt)
    raise last_error

def clist(fs,pz=20,fid="f3"):
    j=get(BASE,{"pn":1,"pz":pz,"po":1,"np":1,"fltt":2,"invt":2,"fid":fid,"fs":fs,
                "fields":"f2,f3,f5,f6,f8,f10,f12,f14,f15,f16,f17,f18,f20,f21,f62,f184"})
    return (j.get("data") or {}).get("diff") or []

def get_text(url, params=None, encoding="utf-8"):
    last_error=None
    for attempt in range(4):
        try:
            target=url+("?"+urlencode(params) if params else "")
            req=Request(target,headers=HEADERS)
            with urlopen(req,timeout=25) as r:
                return r.read().decode(encoding,errors="replace")
        except Exception as exc:
            last_error=exc
            time.sleep(2 ** attempt)
    raise last_error

def secid(code):
    return ("1." if code.startswith(("6","9")) else "0.")+code

def symbol(code):
    if code.startswith(("4","8","92")):
        return "bj"+code
    return ("sh" if code.startswith(("6","9")) else "sz")+code

def tencent_quote(code):
    raw=get_text(TENCENT_QUOTE+symbol(code),encoding="gb18030")
    match=re.search(r'="(.*)"',raw)
    a=(match.group(1) if match else "").split("~")
    if len(a)<40 or not a[3]:
        raise ValueError("Tencent quote is empty")
    return {"name":a[1],"price":float(a[3]),"pct":float(a[32] or 0),
            "volume":float(a[36] or 0) if a[36] else float(a[6] or 0)*100,"amount":float(a[37] or 0)*10000}, "腾讯财经"

def eastmoney_quote(code):
    j=get(QBASE,{"secid":secid(code),"fltt":2,
                 "fields":"f43,f47,f48,f57,f58,f170"})
    q=j.get("data") or {}
    if q.get("f43") is None:
        raise ValueError("Eastmoney quote is empty")
    return {"name":q.get("f58") or code,"price":float(q["f43"]),"pct":float(q.get("f170") or 0),
            "volume":float(q.get("f47") or 0)*100,"amount":float(q.get("f48") or 0)}, "东方财富"

def quote(code):
    try:
        return tencent_quote(code)
    except Exception as exc:
        print("quote fallback",code,exc)
        return eastmoney_quote(code)

def tencent_klines(code):
    s=symbol(code)
    j=get(TENCENT_K,{"param":f"{s},day,,,90,qfq"})
    root=((j.get("data") or {}).get(s) or {})
    rows=root.get("qfqday") or root.get("day") or []
    if not rows:
        raise ValueError("Tencent kline is empty")
    out=[]
    previous=None
    for a in rows:
        close=float(a[2])
        pct=(close/previous-1)*100 if previous else 0
        out.append({"date":a[0],"open":float(a[1]),"close":close,"high":float(a[3]),"low":float(a[4]),
                    "volume":float(a[5])*100,"amount":float(a[6]) if len(a)>6 and a[6] else 0,"pct":pct})
        previous=close
    return out, "腾讯财经"

def eastmoney_klines(code):
    j=get(KBASE,{"secid":secid(code),"klt":101,"fqt":1,"lmt":90,"end":"20500101",
                 "fields1":"f1,f2,f3,f4,f5,f6","fields2":"f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"})
    rows=(j.get("data") or {}).get("klines") or []
    out=[]
    for row in rows:
        a=row.split(",")
        out.append({"date":a[0],"open":float(a[1]),"close":float(a[2]),"high":float(a[3]),"low":float(a[4]),
                    "volume":float(a[5])*100,"amount":float(a[6]),"pct":float(a[8])})
    if not out:
        raise ValueError("Eastmoney kline is empty")
    return out, "东方财富"

def klines(code):
    try:
        return tencent_klines(code)
    except Exception as exc:
        print("kline fallback",code,exc)
        return eastmoney_klines(code)

def avg(items):
    return sum(items)/len(items) if items else 0

def session_progress(now=None):
    now=now or datetime.now(ZoneInfo("Asia/Shanghai"))
    minute=now.hour*60+now.minute
    if minute < 570: return 0.08
    if minute <= 690: return max(0.08,(minute-570)/240)
    if minute < 780: return 0.5
    if minute <= 900: return 0.5+(minute-780)/240
    return 1.0

def market_trade_date():
    try:
        raw=get_text(TENCENT_QUOTE+"sh000001",encoding="gb18030")
        match=re.search(r'="(.*)"',raw)
        a=(match.group(1) if match else "").split("~")
        stamp=a[30] if len(a)>30 else ""
        found=re.search(r"(20\d{6})",stamp)
        if found:
            return datetime.strptime(found.group(1),"%Y%m%d").date()
    except Exception as exc:
        print("market date tencent fallback",exc)
    try:
        j=get(KBASE,{"secid":"1.000001","klt":101,"fqt":1,"lmt":5,"end":"20500101",
                     "fields1":"f1,f2,f3,f4,f5,f6","fields2":"f51,f52,f53,f54,f55,f56"})
        rows=(j.get("data") or {}).get("klines") or []
        if rows:
            return datetime.strptime(rows[-1].split(",")[0],"%Y-%m-%d").date()
    except Exception as exc:
        print("market date eastmoney failed",exc)
    return None

def analyze(raw, board):
    code=raw["f12"]
    k,k_source=klines(code)
    q,q_source=quote(code)
    if len(k)<31: return None
    last,prev=k[-1],k[-2]
    avg5=avg([x["volume"] for x in k[-6:-1]])
    ma=lambda n:avg([x["close"] for x in k[-n:]])
    ma5,ma10,ma20,ma30=ma(5),ma(10),ma(20),ma(30)
    max20=max(x["high"] for x in k[-21:-1])
    price=q["price"] if q.get("price") is not None else last["close"]
    day_pct=q["pct"] if q.get("pct") is not None else last["pct"]
    volume=q["volume"] if q.get("volume") is not None else last["volume"]
    amount=q["amount"] if q.get("amount") is not None else last["amount"]
    r10=(price/k[-11]["close"]-1)*100
    r20=(price/k[-21]["close"]-1)*100
    d10=(price/ma10-1)*100
    d30=(price/ma30-1)*100
    raw_vr=volume/avg5 if avg5 else 0
    volume_pace=raw_vr/max(0.08,session_progress())
    signal,score="趋势观察",45
    if price>max20 and volume_pace>1.5: signal,score="放量突破",88
    elif ma20*.98<=price<=ma20*1.04 and volume_pace<.82 and r20>4: signal,score="缩量回踩",82
    elif day_pct>2 and prev["pct"]<0 and volume_pace>1.05: signal,score="弱转强",78
    elif abs(day_pct)<2 and volume_pace>1.8 and r20>15: signal,score="放量滞涨",30
    if ma5>ma10>ma20: score+=7
    if day_pct>0: score+=3
    if r20>35: score-=10
    if d10>12: score-=8
    source=q_source if q_source==k_source else f"{q_source}（行情）/{k_source}（K线）"
    return {"code":code,"name":q.get("name") or raw["f14"],"sector":board,"price":price,"pct":day_pct,
            "volume":volume,"amount":amount,"avg3_volume":avg([x["volume"] for x in k[-3:]]),
            "return_10d":round(r10,2),"return_20d":round(r20,2),"deviation_10d":round(d10,2),
            "deviation_30d":round(d30,2),"volume_ratio":round(raw_vr,2),"volume_pace":round(volume_pace,2),"signal":signal,
            "score":max(0,min(99,score)),"source":source}

def announcements(code):
    url="https://np-anotice-stock.eastmoney.com/api/security/ann"
    try:
        j=get(url,{"sr":-1,"page_size":5,"page_index":1,"ann_type":"A","client_source":"web","stock_list":code})
        rows=((j.get("data") or {}).get("list") or [])
        out=[]
        for x in rows:
            title=x.get("title","")
            tone="偏利空" if NEG.search(title) else "偏利好" if POS.search(title) else "中性/待核实"
            out.append({"title":title,"tone":tone})
        return out
    except Exception as e:
        return [{"title":"公告接口不可用","tone":"需人工核对","error":str(e)}]

def fetch_rss(url, category):
    last_error=None
    for attempt in range(3):
        try:
            req=Request(url,headers=HEADERS)
            with urlopen(req,timeout=25) as r:
                raw=r.read()
            root=ET.fromstring(raw)
            out=[]
            for item in root.findall(".//item")[:40]:
                title=(item.findtext("title") or "").strip()
                link=(item.findtext("link") or "").strip()
                pub=(item.findtext("pubDate") or "").strip()
                if not title or not link or EVENT_EXCLUDE.search(title):
                    continue
                rule=DOMESTIC_EVENT if category=="国内" else GLOBAL_EVENT
                if not rule.search(title):
                    continue
                try:
                    dt=parsedate_to_datetime(pub)
                    if dt.tzinfo is None:
                        dt=dt.replace(tzinfo=ZoneInfo("Asia/Shanghai"))
                    dt=dt.astimezone(ZoneInfo("Asia/Shanghai"))
                except Exception:
                    continue
                now=datetime.now(ZoneInfo("Asia/Shanghai"))
                if dt < now-timedelta(days=7) or dt > now+timedelta(days=1):
                    continue
                source="Bing News" if "bing.com" in url else "Google News" if "google.com" in url else "新闻聚合"
                out.append({"title":title,"link":link,"category":category,"source":source,
                            "date":dt.strftime("%Y-%m-%d"),"time":dt.strftime("%H:%M"),
                            "timestamp":dt.isoformat()})
            return out
        except Exception as exc:
            last_error=exc
            time.sleep(2 ** attempt)
    print("rss failed",url,last_error)
    return []

def update_events():
    domestic_bing="https://www.bing.com/news/search?"+urlencode({"q":"中国 国务院 央行 证监会 财政 经济 政策 科技","format":"rss","setlang":"zh-cn"})
    world_bing="https://www.bing.com/news/search?"+urlencode({"q":"全球 国际 冲突 央行 贸易 能源 科技","format":"rss","setlang":"zh-cn"})
    domestic_google="https://news.google.com/rss/search?"+urlencode({"q":"中国 国务院 央行 证监会 财政 经济 政策 科技 when:3d","hl":"zh-CN","gl":"CN","ceid":"CN:zh-Hans"})
    world_google="https://news.google.com/rss/search?"+urlencode({"q":"全球 国际 冲突 央行 贸易 能源 科技 when:3d","hl":"zh-CN","gl":"CN","ceid":"CN:zh-Hans"})
    feeds=[
        ("国内",[domestic_bing,domestic_google]),
        ("国际",[world_bing,world_google])
    ]
    events=[]
    for category,urls in feeds:
        rows=[]
        for url in urls:
            rows=fetch_rss(url,category)
            if rows:
                break
        events.extend(rows[:30])
    seen=set()
    events=[x for x in sorted(events,key=lambda x:x["timestamp"],reverse=True)
            if not (x["title"] in seen or seen.add(x["title"]))]
    if events:
        Path("data").mkdir(exist_ok=True)
        Path("data/events.json").write_text(json.dumps({"generated_at":datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
                                                       "events":events},ensure_ascii=False,indent=2),encoding="utf-8")
        print("events",len(events))
    else:
        Path("data").mkdir(exist_ok=True)
        Path("data/events.json").write_text(json.dumps({"generated_at":datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),"events":[],"status":"news sources unavailable"},ensure_ascii=False,indent=2),encoding="utf-8")
        print("no fresh events; stale entries cleared")

def normalize(values):
    clean=[float(v or 0) for v in values]
    lo,hi=min(clean,default=0),max(clean,default=0)
    return [0.5 if hi==lo else (v-lo)/(hi-lo) for v in clean]

def resolve_fixed(boards):
    resolved=[]
    for label,aliases in FIXED_SECTORS:
        match=next((b for b in boards if b.get("f14") in aliases),None)
        if not match:
            match=next((b for b in boards if any(a in (b.get("f14") or "") or (b.get("f14") or "") in a for a in aliases)),None)
        if match:
            item=dict(match);item["display_name"]=label;item["pool_source"]="固定关注"
            resolved.append(item)
    return resolved

def write_health(status,details=None):
    Path("data").mkdir(exist_ok=True)
    payload={"generated_at":datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),"status":status,
             "details":details or {}}
    Path("data/health.json").write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")

def main():
    now=datetime.now(ZoneInfo("Asia/Shanghai"))
    mode=os.getenv("REPORT_MODE","manual")
    update_events()
    trade_date=market_trade_date()
    if mode=="noon" and (now.weekday()>=5 or trade_date!=now.date()):
        payload={"generated_at":now.isoformat(),"report_date":now.date().isoformat(),"mode":mode,
                 "market_status":"closed","last_trading_date":trade_date.isoformat() if trade_date else None,
                 "source":"交易日由指数行情日期校验","hot_sectors":[],"selected_sectors":[],"candidates":[],
                 "notice":"今日休市，未生成或伪造实时行情。"}
        Path("data").mkdir(exist_ok=True);Path("reports").mkdir(exist_ok=True)
        Path("data/latest.json").write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
        Path("reports",now.strftime("%Y-%m-%d-%H%M")+".json").write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
        write_health("closed",{"last_trading_date":payload["last_trading_date"]})
        print("market closed",payload["last_trading_date"]);return
    report_date=(trade_date if mode=="previous" and trade_date else now.date()).isoformat()
    try:
        boards=clist("m:90+t:2",500)+clist("m:90+t:3",500)
    except Exception as exc:
        write_health("degraded",{"stage":"board_list","error":str(exc)})
        print("market snapshot unavailable; preserving previous snapshot",exc);return
    unique={}
    for b in boards:
        name=b.get("f14")
        if name and name not in unique and not META_BOARD.search(name): unique[name]=b
    all_boards=list(unique.values())
    market_hot=sorted(all_boards,key=lambda x:float(x.get("f3") or -999),reverse=True)[:5]
    fixed=resolve_fixed(all_boards)
    pool=[];seen=set()
    for b in fixed+market_hot:
        if b.get("f12") not in seen:
            seen.add(b.get("f12"));pool.append(dict(b))
    pct_norm=normalize([b.get("f3") for b in pool])
    flow_norm=normalize([(float(b.get("f62") or 0)/max(1,float(b.get("f6") or 0)))*100 for b in pool])
    amount_norm=normalize([float(b.get("f6") or 0) for b in pool])
    for i,b in enumerate(pool):
        b["heat_score"]=round(pct_norm[i]*55+flow_norm[i]*25+amount_norm[i]*20,1)
    selected=sorted(pool,key=lambda x:x["heat_score"],reverse=True)[:5]
    flow_rows=[b for b in all_boards if b.get("f62") is not None]
    inflow=sorted(flow_rows,key=lambda x:float(x.get("f62") or 0),reverse=True)[:5]
    outflow=sorted(flow_rows,key=lambda x:float(x.get("f62") or 0))[:5]
    candidates=[]
    for b in selected:
        try: rows=clist("b:"+b["f12"],18)
        except Exception as exc:
            print("skip board",b.get("f14"),exc);continue
        scored=[]
        for row in rows[:12]:
            try:
                item=analyze(row,b.get("display_name") or b["f14"])
                if item: scored.append(item)
            except Exception as exc:
                print("skip stock",row.get("f12"),exc)
        scored.sort(key=lambda x:x["score"],reverse=True)
        for item in scored[:5]: item["announcements"]=announcements(item["code"])
        candidates.extend(scored[:5])
    hot_stocks=[]
    try:
        stocks=clist("m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23",150,"f6")
        valid=[x for x in stocks if re.match(r"^\d{6}$",str(x.get("f12",""))) and not re.search(r"ST|退",x.get("f14",""))]
        for x in valid:
            heat=(max(1,float(x.get("f6") or 0))).bit_length() if isinstance(x.get("f6"),int) else 0
            hot_stocks.append({"code":x.get("f12"),"name":x.get("f14"),"price":x.get("f2"),"pct":x.get("f3"),
                               "amount":x.get("f6"),"turnover":x.get("f8"),"volume_ratio":x.get("f10")})
        hot_stocks=hot_stocks[:10]
    except Exception as exc:
        print("hot stocks unavailable",exc)
    payload={"generated_at":now.isoformat(),"report_date":report_date,"mode":mode,"market_status":"open",
             "source":"个股行情与K线：腾讯财经优先，东方财富容灾；板块目录与公告：东方财富",
             "fixed_sectors":[{"code":b["f12"],"name":b.get("display_name") or b["f14"],"pct":b.get("f3")} for b in fixed],
             "hot_sectors":[{"code":b["f12"],"name":b["f14"],"pct":b.get("f3")} for b in market_hot],
             "attention_pool":[{"code":b["f12"],"name":b.get("display_name") or b["f14"],"pct":b.get("f3"),"heat_score":b["heat_score"]} for b in pool],
             "selected_sectors":[{"code":b["f12"],"name":b.get("display_name") or b["f14"],"pct":b.get("f3"),"heat_score":b["heat_score"]} for b in selected],
             "inflow_sectors":[{"code":b["f12"],"name":b["f14"],"pct":b.get("f3"),"flow":b.get("f62")} for b in inflow],
             "outflow_sectors":[{"code":b["f12"],"name":b["f14"],"pct":b.get("f3"),"flow":b.get("f62")} for b in outflow],
             "hot_stocks":hot_stocks,"candidates":candidates,
             "notice":"成交量统一为股；盘中量速按交易进度校正。技术偏离率不等同于交易所监管口径；报告不构成投资建议。"}
    Path("data").mkdir(exist_ok=True);Path("reports").mkdir(exist_ok=True)
    Path("data/latest.json").write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    Path("reports",now.strftime("%Y-%m-%d-%H%M")+".json").write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    write_health("ok",{"candidates":len(candidates),"selected_sectors":len(selected),"mode":mode})
    print("generated",now.strftime("%Y-%m-%d-%H%M"),len(candidates))

if __name__=="__main__":
    main()
