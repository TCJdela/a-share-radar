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
HEADERS={"User-Agent":"Mozilla/5.0","Referer":"https://quote.eastmoney.com/"}
POS=re.compile(r"增持|回购|中标|预增|扭亏|分红|签订|获批|突破")
NEG=re.compile(r"减持|亏损|处罚|立案|诉讼|终止|退市|风险|质押")
META_BOARD=re.compile(r"昨日|涨停|连板|ST|预盈|融资融券|深股通|沪股通|百元股|机构重仓|基金重仓|MSCI|标准普尔|证金持股|AH股|次新股|破净股|低价股|高送转|转债标的")

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

def secid(code):
    return ("1." if code.startswith(("6","9")) else "0.")+code

def klines(code):
    j=get(KBASE,{"secid":secid(code),"klt":101,"fqt":1,"lmt":90,"end":"20500101",
                 "fields1":"f1,f2,f3,f4,f5,f6","fields2":"f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"})
    rows=(j.get("data") or {}).get("klines") or []
    out=[]
    for row in rows:
        a=row.split(",")
        out.append({"date":a[0],"open":float(a[1]),"close":float(a[2]),"high":float(a[3]),"low":float(a[4]),
                    "volume":float(a[5]),"amount":float(a[6]),"pct":float(a[8])})
    return out

def avg(items):
    return sum(items)/len(items) if items else 0

def analyze(raw, board):
    k=klines(raw["f12"])
    if len(k)<31: return None
    last,prev=k[-1],k[-2]
    avg5=avg([x["volume"] for x in k[-6:-1]])
    ma=lambda n:avg([x["close"] for x in k[-n:]])
    ma5,ma10,ma20,ma30=ma(5),ma(10),ma(20),ma(30)
    max20=max(x["high"] for x in k[-21:-1])
    r10=(last["close"]/k[-11]["close"]-1)*100
    r20=(last["close"]/k[-21]["close"]-1)*100
    d10=(last["close"]/ma10-1)*100
    d30=(last["close"]/ma30-1)*100
    vr=last["volume"]/avg5 if avg5 else 0
    signal,score="趋势观察",45
    if last["close"]>max20 and vr>1.5: signal,score="放量突破",88
    elif ma20*.98<=last["close"]<=ma20*1.04 and vr<.82 and r20>4: signal,score="缩量回踩",82
    elif last["pct"]>2 and prev["pct"]<0 and vr>1.05: signal,score="弱转强",78
    elif abs(last["pct"])<2 and vr>1.8 and r20>15: signal,score="放量滞涨",30
    if ma5>ma10>ma20: score+=7
    if raw.get("f3",0)>0: score+=3
    if r20>35: score-=10
    if d10>12: score-=8
    return {"code":raw["f12"],"name":raw["f14"],"sector":board,"price":last["close"],"pct":last["pct"],
            "volume":last["volume"],"amount":last["amount"],"avg3_volume":avg([x["volume"] for x in k[-3:]]),
            "return_10d":round(r10,2),"return_20d":round(r20,2),"deviation_10d":round(d10,2),
            "deviation_30d":round(d30,2),"volume_ratio":round(vr,2),"signal":signal,
            "score":max(0,min(99,score))}

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
                if not title or not link:
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
    domestic_bing="https://www.bing.com/news/search?"+urlencode({"q":"中国 国内 重大 新闻","format":"rss","setlang":"zh-cn"})
    world_bing="https://www.bing.com/news/search?"+urlencode({"q":"国际 全球 重大 新闻","format":"rss","setlang":"zh-cn"})
    domestic_google="https://news.google.com/rss/search?"+urlencode({"q":"中国 国内 重大 新闻 when:3d","hl":"zh-CN","gl":"CN","ceid":"CN:zh-Hans"})
    world_google="https://news.google.com/rss/search?"+urlencode({"q":"国际 全球 重大 新闻 when:3d","hl":"zh-CN","gl":"CN","ceid":"CN:zh-Hans"})
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

def main():
    now=datetime.now(ZoneInfo("Asia/Shanghai"))
    mode=os.getenv("REPORT_MODE","manual")
    report_date=(now.date()-timedelta(days=1) if mode=="previous" else now.date()).isoformat()
    update_events()
    try:
        boards=clist("m:90+t:2",15)+clist("m:90+t:3",15)
    except Exception as exc:
        print("market snapshot unavailable; preserving previous snapshot",exc)
        return
    unique={}
    for b in sorted(boards,key=lambda x:x.get("f3",-999),reverse=True):
        if b.get("f14") not in unique: unique[b.get("f14")]=b
    hot=[b for b in unique.values() if not META_BOARD.search(b.get("f14",""))][:5]
    candidates=[]
    for b in hot:
        try:
            rows=clist("b:"+b["f12"],15)
        except Exception as exc:
            print("skip board",b.get("f14"),exc)
            continue
        scored=[]
        for row in rows[:12]:
            try:
                item=analyze(row,b["f14"])
                if item: scored.append(item)
            except Exception:
                continue
        scored.sort(key=lambda x:x["score"],reverse=True)
        for item in scored[:3]:
            item["announcements"]=announcements(item["code"])
        candidates.extend(scored[:5])
    payload={"generated_at":now.isoformat(),"report_date":report_date,"mode":mode,"source":"东方财富公开行情接口",
             "hot_sectors":[{"code":b["f12"],"name":b["f14"],"pct":b.get("f3")} for b in hot],
             "candidates":candidates,
             "notice":"技术偏离率不等同于交易所监管口径；报告不构成投资建议。"}
    Path("data").mkdir(exist_ok=True)
    Path("reports").mkdir(exist_ok=True)
    Path("data/latest.json").write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    stamp=now.strftime("%Y-%m-%d-%H%M")
    Path("reports",stamp+".json").write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    print("generated",stamp,len(candidates))

if __name__=="__main__":
    main()
