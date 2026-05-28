import time
import threading
import json
import os
import re
import datetime
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import requests
from bs4 import BeautifulSoup
import uvicorn
import urllib3

# SSL 인증서 검증 경고 비활성화 및 requests 몽키 패치
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
original_get = requests.get
def patched_get(*args, **kwargs):
    kwargs['verify'] = False
    return original_get(*args, **kwargs)
requests.get = patched_get

def safe_float(val, default=0.0):
    try:
        return float(val) if val else default
    except (ValueError, TypeError):
        return default

def safe_int(val, default=0):
    try:
        return int(val) if val else default
    except (ValueError, TypeError):
        return default

CHOSUNG_LIST = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']


app = FastAPI(title="K-Stock Dashboard API")

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
async def startup_event():
    start_stocks_updater()

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://m.stock.naver.com/'
}

# 심플 인메모리 캐시 시스템 (네이버 금융 차단 방지)
CACHE = {}
CACHE_EXPIRE_SECONDS = 2  # 캐시 유효 시간: 2초

STOCKS_FILE = "stocks.json"
STOCKS_LIST = []  # [{"code": "005930", "name": "삼성전자"}, ...]
STOCKS_LOCK = threading.Lock()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WATCHLIST_FILE = os.path.join(BASE_DIR, "watchlist.json")

class WatchlistItem(BaseModel):
    code: str
    avgPrice: float
    quantity: float = 0.0  # 소수점 4자리 지원을 위해 float으로 수정

class Account(BaseModel):
    id: str
    name: str
    watchlist: list[WatchlistItem] = []

class WatchlistData(BaseModel):
    accounts: list[Account] = []


def load_watchlist():
    if os.path.exists(WATCHLIST_FILE):
        try:
            with open(WATCHLIST_FILE, "r", encoding="utf-8") as f:
                raw_data = json.load(f)
                
                # 하위 호환성 마이그레이션: 기존 단일 관심종목 목록을 "기본 계좌"로 래핑
                if isinstance(raw_data, list):
                    migrated_watchlist = []
                    for item in raw_data:
                        if isinstance(item, dict):
                            migrated_watchlist.append({
                                "code": item.get("code", ""),
                                "avgPrice": float(item.get("avgPrice", 0.0)),
                                "quantity": float(item.get("quantity", 0.0))
                            })
                    migrated_data = {
                        "accounts": [
                            {
                                "id": "default_acc",
                                "name": "기본 계좌",
                                "watchlist": migrated_watchlist
                            }
                        ]
                    }
                    save_watchlist(migrated_data)
                    return migrated_data
                
                elif isinstance(raw_data, dict) and "accounts" in raw_data:
                    # 각 계좌 및 아이템 정보 정규화
                    accounts = []
                    for acc in raw_data.get("accounts", []):
                        wl = []
                        for item in acc.get("watchlist", []):
                            wl.append({
                                "code": item.get("code", ""),
                                "avgPrice": float(item.get("avgPrice", 0.0)),
                                "quantity": float(item.get("quantity", 0.0))
                            })
                        accounts.append({
                            "id": acc.get("id", "default_acc"),
                            "name": acc.get("name", "미지정 계좌"),
                            "watchlist": wl
                        })
                    return {"accounts": accounts}
        except Exception as e:
            print("Failed to load watchlist.json:", e)
    
    # 기본값
    default_data = {
        "accounts": [
            {
                "id": "default_acc",
                "name": "기본 계좌",
                "watchlist": [
                    {"code": "005930", "avgPrice": 0.0, "quantity": 0.0},
                    {"code": "000660", "avgPrice": 0.0, "quantity": 0.0},
                    {"code": "360200", "avgPrice": 0.0, "quantity": 0.0}
                ]
            }
        ]
    }
    save_watchlist(default_data)
    return default_data

def save_watchlist(data):
    try:
        with open(WATCHLIST_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("Failed to save watchlist.json:", e)


def get_chosung(text: str) -> str:
    chosung = []
    for char in text:
        code = ord(char)
        if 0xAC00 <= code <= 0xD7A3:
            chosung_index = (code - 0xAC00) // 588
            chosung.append(CHOSUNG_LIST[chosung_index])
        else:
            chosung.append(char)
    return "".join(chosung)

def load_stocks():
    global STOCKS_LIST
    if os.path.exists(STOCKS_FILE):
        try:
            with open(STOCKS_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                with STOCKS_LOCK:
                    STOCKS_LIST = loaded
            print(f"Loaded {len(STOCKS_LIST)} stocks from {STOCKS_FILE}")
        except Exception as e:
            print("Failed to load stocks.json:", e)

def save_stocks(stocks):
    try:
        with open(STOCKS_FILE, "w", encoding="utf-8") as f:
            json.dump(stocks, f, ensure_ascii=False, indent=2)
        print(f"Saved {len(stocks)} stocks to {STOCKS_FILE}")
    except Exception as e:
        print("Failed to save stocks.json:", e)

def crawl_all_stocks():
    global STOCKS_LIST
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    
    new_stocks = []
    seen_codes = set()
    
    # 0 = KOSPI, 1 = KOSDAQ
    for sosok in [0, 1]:
        page = 1
        while True:
            url = f"https://finance.naver.com/sise/sise_market_sum.naver?sosok={sosok}&page={page}"
            try:
                res = requests.get(url, headers=headers, timeout=5)
                if res.status_code != 200:
                    break
                res.encoding = 'euc-kr'
                soup = BeautifulSoup(res.text, 'html.parser')
                links = soup.select('a.tltle')
                if not links:
                    break
                
                for a in links:
                    name = a.text.strip()
                    href = a.get('href', '')
                    code = href.split('code=')[-1] if 'code=' in href else ''
                    if code and code not in seen_codes:
                        seen_codes.add(code)
                        new_stocks.append({"code": code, "name": name})
                
                page += 1
                time.sleep(0.15)  # 과부하 방지 지연
            except Exception as e:
                print(f"Error crawling sosok={sosok}, page={page}: {e}")
                break
                
    if new_stocks:
        with STOCKS_LOCK:
            STOCKS_LIST = new_stocks
        save_stocks(new_stocks)

def start_stocks_updater():
    load_stocks()
    # 서버 기동과 무관하게 백그라운드 스레드로 갱신 구동
    t = threading.Thread(target=crawl_all_stocks, daemon=True)
    t.start()


def get_cached_or_fetch(cache_key: str, fetch_func):
    now = time.time()
    if cache_key in CACHE:
        val, expire_time = CACHE[cache_key]
        if now < expire_time:
            return val
    
    # 캐시 만료되었거나 없을 시 새로 패치
    try:
        data = fetch_func()
        CACHE[cache_key] = (data, now + CACHE_EXPIRE_SECONDS)
        return data
    except Exception as e:
        # 패치 실패 시 기존 캐시가 있다면 리턴, 없으면 예외 발생
        if cache_key in CACHE:
            return CACHE[cache_key][0]
        raise e

# --- 스크래핑 및 API 호출 유틸리티 함수들 ---

def fetch_gold_scraping():
    # 국내 금 시세 스크래핑 (euc-kr 인코딩 필수)
    url = "https://finance.naver.com/marketindex/"
    res = requests.get(url, headers=HEADERS, timeout=5)
    res.encoding = 'euc-kr'
    if res.status_code != 200:
        raise Exception("금 시세 페이지 로드 실패")
        
    soup = BeautifulSoup(res.text, 'html.parser')
    gold_link = soup.select_one('a.gold_domestic')
    if not gold_link:
        raise Exception("금 시세 데이터를 찾을 수 없음")
        
    price = gold_link.select_one('.value').text.strip()
    change = gold_link.select_one('.change').text.strip()
    
    status = "SAME"
    rate = "0.00"
    
    full_text = gold_link.text
    if '상승' in full_text:
        status = "UP"
    elif '하락' in full_text:
        status = "DOWN"
        
    # 등락률 계산
    try:
        price_num = float(price.replace(',', ''))
        change_num = float(change.replace(',', ''))
        if status == "DOWN":
            prev_price = price_num + change_num
            rate = f"{(change_num / prev_price * 100):.2f}"
        elif status == "UP":
            prev_price = price_num - change_num
            rate = f"{(change_num / prev_price * 100):.2f}"
        else:
            rate = "0.00"
    except Exception:
        rate = "0.00"
        
    return {
        "name": "국내 금 시세",
        "price": price,
        "change": change,
        "rate": rate,
        "status": status
    }

def fetch_market_summary():
    # 1. 코스피 & 코스닥 (polling API)
    index_url = 'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ'
    index_res = requests.get(index_url, headers=HEADERS, timeout=5)
    index_data = index_res.json() if index_res.status_code == 200 else {}
    
    indices = {}
    for item in index_data.get('datas', []):
        code = item.get('itemCode')  # KOSPI / KOSDAQ
        fluctuations_ratio = safe_float(item.get('fluctuationsRatio', 0))
        indices[code] = {
            "name": item.get('stockName'),
            "price": item.get('closePrice'),
            "change": item.get('compareToPreviousClosePrice'),
            "rate": item.get('fluctuationsRatio'),
            "status": "UP" if fluctuations_ratio > 0 else "DOWN" if fluctuations_ratio < 0 else "SAME"
        }
        
    # 2. 환율 (원달러 - marketindex API)
    exchange_url = 'https://api.stock.naver.com/marketindex/exchange/FX_USDKRW'
    ex_res = requests.get(exchange_url, headers=HEADERS, timeout=5)
    ex_data = ex_res.json().get('exchangeInfo', {}) if ex_res.status_code == 200 else {}
    
    exchange_rate = "0.00"
    exchange_status = "SAME"
    try:
        ex_ratio = safe_float(ex_data.get('fluctuationsRatio', 0))
        exchange_rate = f"{ex_ratio:.2f}"
        exchange_status = "UP" if ex_ratio > 0 else "DOWN" if ex_ratio < 0 else "SAME"
    except Exception:
        pass
        
    exchange = {
        "name": ex_data.get('name', '원달러 환율'),
        "price": ex_data.get('closePrice'),
        "change": ex_data.get('fluctuations'),
        "rate": exchange_rate,
        "status": exchange_status
    }

    # 3. 나스닥 종합지수 (NASDAQ - basic API)
    try:
        nasdaq_url = 'https://api.stock.naver.com/index/.IXIC/basic'
        nas_res = requests.get(nasdaq_url, headers=HEADERS, timeout=5)
        nas_data = nas_res.json() if nas_res.status_code == 200 else {}
        nas_ratio = safe_float(nas_data.get('fluctuationsRatio', 0))
        nasdaq = {
            "name": "NASDAQ",
            "price": nas_data.get('closePrice'),
            "change": nas_data.get('compareToPreviousClosePrice'),
            "rate": f"{nas_ratio:.2f}",
            "status": "UP" if nas_ratio > 0 else "DOWN" if nas_ratio < 0 else "SAME"
        }
    except Exception as e:
        print("NASDAQ fetch error:", e)
        nasdaq = {
            "name": "NASDAQ",
            "price": "-",
            "change": "-",
            "rate": "0.00",
            "status": "SAME"
        }

    # 4. WTI 유가(OIL_CL) & 골드(달러)(CMDT_GC) 스크래핑
    wti = {
        "name": "WTI 유가(달러)",
        "price": "-",
        "change": "-",
        "rate": "0.00",
        "status": "SAME"
    }
    gold_dollar = {
        "name": "국제 금(달러)",
        "price": "-",
        "change": "-",
        "rate": "0.00",
        "status": "SAME"
    }

    try:
        res = requests.get("https://finance.naver.com/marketindex/", headers=HEADERS, timeout=5)
        res.encoding = 'euc-kr'
        soup = BeautifulSoup(res.text, 'html.parser')
        
        # WTI 파싱
        wti_link = soup.find('a', href=re.compile(r'OIL_CL'))
        if wti_link:
            wti_li = wti_link.find_parent('li') or wti_link
            wti_price = wti_li.select_one('.value').text.strip() if wti_li.select_one('.value') else "-"
            wti_change = wti_li.select_one('.change').text.strip() if wti_li.select_one('.change') else "-"
            wti_status = "SAME"
            if '상승' in wti_li.text:
                wti_status = "UP"
            elif '하락' in wti_li.text:
                wti_status = "DOWN"
            
            # 등락률 계산
            try:
                p_num = float(wti_price.replace(',', ''))
                c_num = float(wti_change.replace(',', ''))
                prev = p_num + c_num if wti_status == "DOWN" else p_num - c_num
                wti_rate = f"{(c_num / prev * 100):.2f}" if prev > 0 else "0.00"
            except Exception:
                wti_rate = "0.00"
                
            wti = {
                "name": "WTI 유가(달러)",
                "price": wti_price,
                "change": wti_change,
                "rate": wti_rate,
                "status": wti_status
            }

        # 국제 금(달러) 파싱
        gold_link = soup.find('a', href=re.compile(r'CMDT_GC'))
        if gold_link:
            gold_li = gold_link.find_parent('li') or gold_link
            gold_price = gold_li.select_one('.value').text.strip() if gold_li.select_one('.value') else "-"
            gold_change = gold_li.select_one('.change').text.strip() if gold_li.select_one('.change') else "-"
            gold_status = "SAME"
            if '상승' in gold_li.text:
                gold_status = "UP"
            elif '하락' in gold_li.text:
                gold_status = "DOWN"
            
            # 등락률 계산
            try:
                p_num = float(gold_price.replace(',', ''))
                c_num = float(gold_change.replace(',', ''))
                prev = p_num + c_num if gold_status == "DOWN" else p_num - c_num
                gold_rate = f"{(c_num / prev * 100):.2f}" if prev > 0 else "0.00"
            except Exception:
                gold_rate = "0.00"
                
            gold_dollar = {
                "name": "국제 금(달러)",
                "price": gold_price,
                "change": gold_change,
                "rate": gold_rate,
                "status": gold_status
            }
    except Exception as e:
        print("Scraping commodities error:", e)

    return {
        "kospi": indices.get("KOSPI"),
        "kosdaq": indices.get("KOSDAQ"),
        "exchange": exchange,
        "nasdaq": nasdaq,
        "wti": wti,
        "gold_dollar": gold_dollar
    }

def fetch_stock_price(code: str):
    # 지수 및 환율, 원자재에 대한 분기 처리
    if code in ["KOSPI", "KOSDAQ"]:
        index_url = 'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ'
        index_res = requests.get(index_url, headers=HEADERS, timeout=5)
        index_data = index_res.json() if index_res.status_code == 200 else {}
        for item in index_data.get('datas', []):
            if item.get('itemCode') == code:
                ratio = safe_float(item.get('fluctuationsRatio', 0))
                return {
                    "code": code,
                    "name": item.get('stockName'),
                    "price": item.get('closePrice'),
                    "change": item.get('compareToPreviousClosePrice'),
                    "rate": item.get('fluctuationsRatio'),
                    "high": item.get('closePrice'),
                    "low": item.get('closePrice'),
                    "open": item.get('closePrice'),
                    "volume": 0,
                    "prev_close": item.get('closePrice'),
                    "status": "UP" if ratio > 0 else "DOWN" if ratio < 0 else "SAME"
                }
                
    elif code == "NASDAQ":
        nasdaq_url = 'https://api.stock.naver.com/index/.IXIC/basic'
        nas_res = requests.get(nasdaq_url, headers=HEADERS, timeout=5)
        nas_data = nas_res.json() if nas_res.status_code == 200 else {}
        ratio = safe_float(nas_data.get('fluctuationsRatio', 0))
        return {
            "code": "NASDAQ",
            "name": "NASDAQ",
            "price": nas_data.get('closePrice'),
            "change": nas_data.get('compareToPreviousClosePrice'),
            "rate": f"{ratio:.2f}",
            "high": nas_data.get('closePrice'),
            "low": nas_data.get('closePrice'),
            "open": nas_data.get('closePrice'),
            "volume": 0,
            "prev_close": nas_data.get('closePrice'),
            "status": "UP" if ratio > 0 else "DOWN" if ratio < 0 else "SAME"
        }
        
    elif code == "USDKRW":
        exchange_url = 'https://api.stock.naver.com/marketindex/exchange/FX_USDKRW'
        ex_res = requests.get(exchange_url, headers=HEADERS, timeout=5)
        ex_data = ex_res.json().get('exchangeInfo', {}) if ex_res.status_code == 200 else {}
        ratio = safe_float(ex_data.get('fluctuationsRatio', 0))
        return {
            "code": "USDKRW",
            "name": "원달러 환율",
            "price": ex_data.get('closePrice'),
            "change": ex_data.get('fluctuations'),
            "rate": f"{ratio:.2f}",
            "high": ex_data.get('closePrice'),
            "low": ex_data.get('closePrice'),
            "open": ex_data.get('closePrice'),
            "volume": 0,
            "prev_close": ex_data.get('closePrice'),
            "status": "UP" if ratio > 0 else "DOWN" if ratio < 0 else "SAME"
        }
        
def fetch_us_stock_price(ticker: str):
    # 야후 파이낸스 chart API를 통해 실시간 시세 및 이전 종가 정보 획득 (401 방지)
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker.upper()}?interval=1d&range=2d"
    yahoo_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
    res = requests.get(url, headers=yahoo_headers, timeout=5)
    if res.status_code != 200:
        raise HTTPException(status_code=404, detail="해외 종목 정보를 가져올 수 없습니다.")
    
    data = res.json()
    result_list = data.get('chart', {}).get('result', [])
    if not result_list:
        raise HTTPException(status_code=404, detail="해당 해외 종목 코드를 찾을 수 없습니다.")
    
    meta = result_list[0].get('meta', {})
    
    price = meta.get('regularMarketPrice', 0.0)
    prev_close = meta.get('chartPreviousClose', price)
    if prev_close is None:
        prev_close = price
        
    change = price - prev_close
    rate = (change / prev_close * 100) if prev_close > 0 else 0.0
    
    if price % 1 != 0:
        price_str = f"{price:,.2f}"
    else:
        price_str = f"{int(price):,}"
        
    if change % 1 != 0:
        change_str = f"{abs(change):,.2f}"
    else:
        change_str = f"{int(abs(change)):,}"
        
    volume = meta.get('regularMarketVolume', 0)
    status = "UP" if change > 0 else "DOWN" if change < 0 else "SAME"
    
    high_val = meta.get('regularMarketDayHigh', price)
    low_val = meta.get('regularMarketDayLow', price)
    open_val = meta.get('regularMarketDayOpen', price)
    if open_val is None:
        open_val = price
    if high_val is None:
        high_val = price
    if low_val is None:
        low_val = price
        
    high_str = f"{high_val:,.2f}" if high_val % 1 != 0 else f"{int(high_val):,}"
    low_str = f"{low_val:,.2f}" if low_val % 1 != 0 else f"{int(low_val):,}"
    open_str = f"{open_val:,.2f}" if open_val % 1 != 0 else f"{int(open_val):,}"
    
    name = meta.get('longName') or meta.get('shortName') or ticker.upper()
    
    return {
        "code": ticker.upper(),
        "name": name,
        "price": price_str,
        "change": change_str,
        "rate": f"{rate:.2f}",
        "high": high_str,
        "low": low_str,
        "open": open_str,
        "volume": volume,
        "prev_close": prev_close,
        "status": status
    }


def fetch_stock_price(code: str):
    # 지수 및 환율, 원자재에 대한 분기 처리
    if code in ["KOSPI", "KOSDAQ"]:
        index_url = 'https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ'
        index_res = requests.get(index_url, headers=HEADERS, timeout=5)
        index_data = index_res.json() if index_res.status_code == 200 else {}
        for item in index_data.get('datas', []):
            if item.get('itemCode') == code:
                ratio = safe_float(item.get('fluctuationsRatio', 0))
                return {
                    "code": code,
                    "name": item.get('stockName'),
                    "price": item.get('closePrice'),
                    "change": item.get('compareToPreviousClosePrice'),
                    "rate": item.get('fluctuationsRatio'),
                    "high": item.get('closePrice'),
                    "low": item.get('closePrice'),
                    "open": item.get('closePrice'),
                    "volume": 0,
                    "prev_close": item.get('closePrice'),
                    "status": "UP" if ratio > 0 else "DOWN" if ratio < 0 else "SAME"
                }
                
    elif code == "NASDAQ":
        nasdaq_url = 'https://api.stock.naver.com/index/.IXIC/basic'
        nas_res = requests.get(nasdaq_url, headers=HEADERS, timeout=5)
        nas_data = nas_res.json() if nas_res.status_code == 200 else {}
        ratio = safe_float(nas_data.get('fluctuationsRatio', 0))
        return {
            "code": "NASDAQ",
            "name": "NASDAQ",
            "price": nas_data.get('closePrice'),
            "change": nas_data.get('compareToPreviousClosePrice'),
            "rate": f"{ratio:.2f}",
            "high": nas_data.get('closePrice'),
            "low": nas_data.get('closePrice'),
            "open": nas_data.get('closePrice'),
            "volume": 0,
            "prev_close": nas_data.get('closePrice'),
            "status": "UP" if ratio > 0 else "DOWN" if ratio < 0 else "SAME"
        }
        
    elif code == "USDKRW":
        exchange_url = 'https://api.stock.naver.com/marketindex/exchange/FX_USDKRW'
        ex_res = requests.get(exchange_url, headers=HEADERS, timeout=5)
        ex_data = ex_res.json().get('exchangeInfo', {}) if ex_res.status_code == 200 else {}
        ratio = safe_float(ex_data.get('fluctuationsRatio', 0))
        return {
            "code": "USDKRW",
            "name": "원달러 환율",
            "price": ex_data.get('closePrice'),
            "change": ex_data.get('fluctuations'),
            "rate": f"{ratio:.2f}",
            "high": ex_data.get('closePrice'),
            "low": ex_data.get('closePrice'),
            "open": ex_data.get('closePrice'),
            "volume": 0,
            "prev_close": ex_data.get('closePrice'),
            "status": "UP" if ratio > 0 else "DOWN" if ratio < 0 else "SAME"
        }
        
    elif code in ["OIL_CL", "CMDT_GC"]:
        res = requests.get("https://finance.naver.com/marketindex/", headers=HEADERS, timeout=5)
        res.encoding = 'euc-kr'
        soup = BeautifulSoup(res.text, 'html.parser')
        
        target_link = soup.find('a', href=re.compile(code))
        if target_link:
            li = target_link.find_parent('li') or target_link
            price = li.select_one('.value').text.strip() if li.select_one('.value') else "-"
            change = li.select_one('.change').text.strip() if li.select_one('.change') else "-"
            status = "SAME"
            if '상승' in li.text:
                status = "UP"
            elif '하락' in li.text:
                status = "DOWN"
            
            try:
                p_num = float(price.replace(',', ''))
                c_num = float(change.replace(',', ''))
                prev = p_num + c_num if status == "DOWN" else p_num - c_num
                rate = f"{(c_num / prev * 100):.2f}" if prev > 0 else "0.00"
            except Exception:
                rate = "0.00"
                
            return {
                "code": code,
                "name": "WTI 유가(달러)" if code == "OIL_CL" else "국제 금(달러)",
                "price": price,
                "change": change,
                "rate": rate,
                "high": price,
                "low": price,
                "open": price,
                "volume": 0,
                "prev_close": price,
                "status": status
            }

    # 해외 주식 판별 (길이가 6이 아니거나 첫 자리가 숫자가 아님)
    is_us_stock = False
    if code not in VALID_INDICES:
        if len(code) != 6 or not code[0].isdigit():
            is_us_stock = True
            
    if is_us_stock:
        return fetch_us_stock_price(code)

    stock_url = f'https://polling.finance.naver.com/api/realtime/domestic/stock/{code}'
    res = requests.get(stock_url, headers=HEADERS, timeout=5)
    if res.status_code != 200:
        raise HTTPException(status_code=404, detail="종목 정보를 가져올 수 없습니다.")
    
    data = res.json()
    datas_list = data.get('datas', [])
    if not datas_list:
        raise HTTPException(status_code=404, detail="해당 종목 코드를 찾을 수 없습니다.")
    
    stock_info = datas_list[0]
    fluctuations_ratio = safe_float(stock_info.get('fluctuationsRatio', 0))
    return {
        "code": code,
        "name": stock_info.get('stockName'),
        "price": stock_info.get('closePrice'),
        "change": stock_info.get('compareToPreviousClosePrice'),
        "rate": stock_info.get('fluctuationsRatio'),
        "high": stock_info.get('highPrice'),
        "low": stock_info.get('lowPrice'),
        "open": stock_info.get('openPrice'),
        "volume": safe_int(stock_info.get('accumulatedTradingVolumeRaw', 0)),
        "prev_close": stock_info.get('previousClosePrice'),
        "status": "UP" if fluctuations_ratio > 0 else "DOWN" if fluctuations_ratio < 0 else "SAME"
    }

def fetch_news():
    # 실시간 뉴스 헤드라인 (네이버 금융 주요뉴스)
    news_url = 'https://finance.naver.com/news/mainnews.naver'
    res = requests.get(news_url, headers=HEADERS, timeout=5)
    if res.status_code != 200:
        return []
    
    res.encoding = 'euc-kr'  # 네이버 뉴스 한글 깨짐 방지
    soup = BeautifulSoup(res.text, 'html.parser')
    
    # 주요 뉴스 항목 파싱
    subjects = soup.select('.mainNewsList .articleSubject a, .newsList .articleSubject a, dd.articleSubject a')
    news_list = []
    
    seen_titles = set()
    for a in subjects:
        title = a.get_text(strip=True)
        if title in seen_titles:
            continue
        seen_titles.add(title)
        
        link = a['href']
        if link.startswith('/'):
            link = "https://finance.naver.com" + link
            
        news_list.append({
            "title": title,
            "link": link
        })
        if len(news_list) >= 10:
            break
            
    return news_list


# --- API 엔드포인트 정의 ---

US_STOCKS_PRESET = [
    {"code": "AAPL", "name": "애플 (AAPL)"},
    {"code": "MSFT", "name": "마이크로소프트 (MSFT)"},
    {"code": "TSLA", "name": "테슬라 (TSLA)"},
    {"code": "NVDA", "name": "엔비디아 (NVDA)"},
    {"code": "AMZN", "name": "아마존닷컴 (AMZN)"},
    {"code": "GOOGL", "name": "알파벳 A (GOOGL)"},
    {"code": "GOOG", "name": "알파벳 C (GOOG)"},
    {"code": "META", "name": "메타 플랫폼스 (META)"},
    {"code": "NFLX", "name": "넷플릭스 (NFLX)"},
    {"code": "AMD", "name": "AMD (AMD)"},
    {"code": "INTC", "name": "인텔 (INTC)"},
    {"code": "QCOM", "name": "퀄컴 (QCOM)"},
    {"code": "AVGO", "name": "브로드컴 (AVGO)"},
    {"code": "ASML", "name": "ASML (ASML)"},
    {"code": "TSM", "name": "TSMC (TSM)"},
    {"code": "LLY", "name": "일라이 릴리 (LLY)"},
    {"code": "UNH", "name": "유나이티드헬스 그룹 (UNH)"},
    {"code": "JPM", "name": "JP모건 체이스 (JPM)"},
    {"code": "V", "name": "비자 (V)"},
    {"code": "MA", "name": "마스터카드 (MA)"},
    {"code": "DIS", "name": "월트 디즈니 (DIS)"},
    {"code": "KO", "name": "코카콜라 (KO)"},
    {"code": "PEP", "name": "펩시코 (PEP)"},
    {"code": "NKE", "name": "나이키 (NKE)"},
    {"code": "SBUX", "name": "스타벅스 (SBUX)"},
    {"code": "XOM", "name": "엑슨모빌 (XOM)"},
    {"code": "CVX", "name": "쉐브론 (CVX)"},
    {"code": "COST", "name": "코스트코 홀세일 (COST)"},
    {"code": "WMT", "name": "월마트 (WMT)"},
    {"code": "BRK-B", "name": "버크셔 해서웨이 Class B (BRK-B)"},
    {"code": "JNJ", "name": "존슨앤존슨 (JNJ)"},
    {"code": "PG", "name": "프록터 앤 갬블 (PG)"},
    {"code": "MRK", "name": "머크 (MRK)"},
    {"code": "ABBV", "name": "애브비 (ABBV)"},
    {"code": "ACN", "name": "액센츄어 (ACN)"},
    {"code": "ORCL", "name": "오라클 (ORCL)"},
    {"code": "TXN", "name": "텍사스 인스트루먼트 (TXN)"},
    {"code": "PM", "name": "필립모리스 인터내셔널 (PM)"},
    {"code": "NOC", "name": "노스롭 그루만 (NOC)"},
    {"code": "LMT", "name": "록히드 마틴 (LMT)"},
    {"code": "RTX", "name": "레이시온 테크놀로지스 (RTX)"},
    {"code": "HON", "name": "하니웰 (HON)"},
    {"code": "CAT", "name": "캐터필러 (CAT)"},
    {"code": "GE", "name": "제너럴 일렉트릭 (GE)"},
    {"code": "BA", "name": "보잉 (BA)"},
    {"code": "UPS", "name": "유나이티드 파셀 서비스 (UPS)"},
    {"code": "FDX", "name": "페덱스 (FDX)"},
    {"code": "T", "name": "AT&T (T)"},
    {"code": "VZ", "name": "버라이즌 커뮤니케이션스 (VZ)"},
    {"code": "PFE", "name": "화이자 (PFE)"},
    {"code": "NVO", "name": "노보 노디스크 (NVO)"},
    {"code": "AZN", "name": "아스트라제네카 (AZN)"},
    {"code": "BABA", "name": "알리바바 그룹 (BABA)"},
    {"code": "PDD", "name": "핀둬둬 (PDD)"},
    {"code": "NIO", "name": "니오 (NIO)"},
    {"code": "COIN", "name": "코인베이스 글로벌 (COIN)"},
    {"code": "PLTR", "name": "팔란티어 테크놀로지스 (PLTR)"},
    {"code": "SQ", "name": "블록 (SQ)"},
    {"code": "PYPL", "name": "페이팔 홀딩스 (PYPL)"},
    {"code": "ARM", "name": "암 홀딩스 (ARM)"},
    {"code": "MU", "name": "마이크론 테크놀로지 (MU)"},
    {"code": "PANW", "name": "팔로알토 네트웍스 (PANW)"},
    {"code": "SNOW", "name": "스노우플레이크 (SNOW)"},
    {"code": "CRWD", "name": "크라우드스트라이크 (CRWD)"},
    {"code": "MSTR", "name": "마이크로스트래티지 (MSTR)"},
    {"code": "SMCI", "name": "슈퍼마이크로컴퓨터 (SMCI)"},
]

@app.get("/api/search")
def search_stocks(q: str = ""):
    if not q:
        return []
    
    query = q.strip().replace(" ", "").lower()
    results = []
    
    # 1. 해외 주식 프리셋 검색 수행
    for stock in US_STOCKS_PRESET:
        name = stock["name"]
        code = stock["code"]
        
        name_clean = name.replace(" ", "").lower()
        chosung = get_chosung(name_clean)
        
        if query in name_clean or query in code.lower() or query in chosung:
            results.append(stock)
            if len(results) >= 10:
                return results

    # 2. 국내 주식 검색 수행
    with STOCKS_LOCK:
        for stock in STOCKS_LIST:
            name = stock["name"]
            code = stock["code"]
            
            name_clean = name.replace(" ", "").lower()
            chosung = get_chosung(name_clean)
            
            if query in name_clean or query in code or query in chosung:
                if not any(r["code"] == code for r in results):
                    results.append(stock)
                    if len(results) >= 10:
                        break
                        
    return results

@app.get("/api/watchlist")
def get_watchlist():
    return load_watchlist()

@app.post("/api/watchlist")
def update_watchlist(data: WatchlistData):
    save_watchlist(data.dict())
    return {"status": "success"}


@app.get("/api/market-summary")
def get_market_summary():
    try:
        return get_cached_or_fetch("market_summary", fetch_market_summary)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

VALID_INDICES = ["KOSPI", "KOSDAQ", "USDKRW", "NASDAQ", "OIL_CL", "CMDT_GC"]

@app.get("/api/stock/{code}")
def get_stock(code: str):
    is_valid_code = code in VALID_INDICES or (1 <= len(code) <= 15 and re.match(r'^[a-zA-Z0-9.\-]+$', code))
    if not is_valid_code:
        raise HTTPException(status_code=400, detail="유효한 종목 코드 또는 티커를 입력해주세요.")
    try:
        return get_cached_or_fetch(f"stock_{code}", lambda: fetch_stock_price(code))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/news")
def get_market_news():
    try:
        return get_cached_or_fetch("news", fetch_news)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- 보조지표 계산 헬퍼 함수들 ---

def calculate_sma(prices, period):
    sma = [None] * len(prices)
    for i in range(period - 1, len(prices)):
        sma[i] = sum(prices[i - period + 1 : i + 1]) / period
    return sma

def calculate_ema(prices, period):
    ema = [None] * len(prices)
    if not prices:
        return ema
    alpha = 2 / (period + 1)
    ema[0] = prices[0]
    for i in range(1, len(prices)):
        ema[i] = prices[i] * alpha + ema[i-1] * (1 - alpha)
    return ema

def calculate_rsi(prices, period=14):
    rsi_values = [None] * len(prices)
    if len(prices) <= period:
        return rsi_values
    
    deltas = [prices[i] - prices[i-1] for i in range(1, len(prices))]
    gains = [d if d > 0 else 0 for d in deltas]
    losses = [-d if d < 0 else 0 for d in deltas]
    
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    
    if avg_loss == 0:
        rsi_values[period] = 100.0
    else:
        rs = avg_gain / avg_loss
        rsi_values[period] = 100.0 - (100.0 / (1.0 + rs))
        
    for i in range(period + 1, len(prices)):
        delta_idx = i - 1
        avg_gain = (avg_gain * (period - 1) + gains[delta_idx]) / period
        avg_loss = (avg_loss * (period - 1) + losses[delta_idx]) / period
        
        if avg_loss == 0:
            rsi_values[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi_values[i] = 100.0 - (100.0 / (1.0 + rs))
            
    return rsi_values

def calculate_macd(prices):
    n = len(prices)
    macd_line = [None] * n
    signal_line = [None] * n
    histogram = [None] * n
    
    if n < 26:
        return macd_line, signal_line, histogram
        
    ema12 = calculate_ema(prices, 12)
    ema26 = calculate_ema(prices, 26)
    
    for i in range(n):
        if ema12[i] is not None and ema26[i] is not None:
            macd_line[i] = ema12[i] - ema26[i]
            
    valid_macd = []
    valid_indices = []
    for i, val in enumerate(macd_line):
        if val is not None:
            valid_macd.append(val)
            valid_indices.append(i)
            
    if len(valid_macd) >= 9:
        alpha = 2 / (9 + 1)
        valid_signal = [None] * len(valid_macd)
        valid_signal[0] = valid_macd[0]
        for i in range(1, len(valid_macd)):
            valid_signal[i] = valid_macd[i] * alpha + valid_signal[i-1] * (1 - alpha)
            
        for idx, i in enumerate(valid_indices):
            signal_line[i] = valid_signal[idx]
            if macd_line[i] is not None and signal_line[i] is not None:
                histogram[i] = macd_line[i] - signal_line[i]
                
    return macd_line, signal_line, histogram


YAHOO_SYMBOLS = {
    "NASDAQ": "^IXIC",
    "USDKRW": "USDKRW=X",
    "OIL_CL": "CL=F",
    "CMDT_GC": "GC=F"
}

def fetch_stock_chart(code: str):
    candles = []
    
    # 해외 주식 판별 (길이가 6이 아니거나 첫 자리가 숫자가 아님)
    is_us_stock = False
    if code not in VALID_INDICES:
        if len(code) != 6 or not code[0].isdigit():
            is_us_stock = True

    if code in YAHOO_SYMBOLS or is_us_stock:
        # 야후 파이낸스 API로부터 1년치 일봉 데이터 조회
        yahoo_sym = YAHOO_SYMBOLS[code] if code in YAHOO_SYMBOLS else code.upper()
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yahoo_sym}?interval=1d&range=1y"
        yahoo_headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        res = requests.get(url, headers=yahoo_headers, timeout=5)
        if res.status_code != 200:
            raise Exception(f"Yahoo Finance API error: status {res.status_code}")
            
        data = res.json()
        result_list = data.get('chart', {}).get('result', [])
        if not result_list:
            raise Exception("Yahoo Finance returns empty results")
            
        result = result_list[0]
        timestamps = result.get('timestamp', [])
        quote = result.get('indicators', {}).get('quote', [{}])[0]
        
        opens = quote.get('open', [])
        highs = quote.get('high', [])
        lows = quote.get('low', [])
        closes = quote.get('close', [])
        volumes = quote.get('volume', [])
        
        for idx, ts in enumerate(timestamps):
            o = opens[idx]
            h = highs[idx]
            l = lows[idx]
            c = closes[idx]
            v = volumes[idx] if idx < len(volumes) and volumes[idx] is not None else 0
            
            if o is None or h is None or l is None or c is None:
                continue
                
            date_str = datetime.datetime.fromtimestamp(ts).strftime('%Y-%m-%d')
            candles.append({
                'time': date_str,
                'open': float(o),
                'high': float(h),
                'low': float(l),
                'close': float(c),
                'volume': float(v)
            })
    else:
        # 기존 네이버 금융 일봉 시세 조회 (KOSPI, KOSDAQ 및 국내주식)
        url = f"https://fchart.stock.naver.com/sise.nhn?symbol={code}&timeframe=day&count=600&requestType=0"
        res = requests.get(url, headers=HEADERS, timeout=5)
        if res.status_code != 200:
            raise Exception("차트 시세 조회 실패")
            
        soup = BeautifulSoup(res.text, 'html.parser')
        items = soup.select('item')
        
        for item in items:
            data = item.get('data', '').split('|')
            if len(data) == 6:
                raw_date = data[0]
                formatted_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
                candles.append({
                    'time': formatted_date,
                    'open': float(data[1]),
                    'high': float(data[2]),
                    'low': float(data[3]),
                    'close': float(data[4]),
                    'volume': float(data[5])
                })
            
    if not candles:
        raise Exception("차트 데이터가 비어있음")
        
    closes = [c['close'] for c in candles]
    
    # 지표 계산
    sma5 = calculate_sma(closes, 5)
    sma10 = calculate_sma(closes, 10)
    sma20 = calculate_sma(closes, 20)
    sma60 = calculate_sma(closes, 60)
    sma120 = calculate_sma(closes, 120)
    rsi = calculate_rsi(closes, 14)
    macd, signal, hist = calculate_macd(closes)
    
    # RSI Signal (9일 EMA) 계산
    rsi_signal = [None] * len(rsi)
    valid_rsi_indices = [i for i, r in enumerate(rsi) if r is not None]
    if len(valid_rsi_indices) >= 9:
        valid_rsi_values = [rsi[i] for i in valid_rsi_indices]
        valid_rsi_signal = calculate_ema(valid_rsi_values, 9)
        for idx, val in enumerate(valid_rsi_signal):
            if val is not None:
                real_idx = valid_rsi_indices[idx]
                rsi_signal[real_idx] = val
    
    # 데이터 병합
    for i in range(len(candles)):
        candles[i]['sma5'] = sma5[i]
        candles[i]['sma10'] = sma10[i]
        candles[i]['sma20'] = sma20[i]
        candles[i]['sma60'] = sma60[i]
        candles[i]['sma120'] = sma120[i]
        candles[i]['rsi'] = rsi[i]
        candles[i]['rsi_signal'] = rsi_signal[i]
        candles[i]['macd'] = macd[i]
        candles[i]['macd_signal'] = signal[i]
        candles[i]['macd_hist'] = hist[i]
        
    return candles

@app.get("/api/stock/{code}/chart")
def get_stock_chart(code: str):
    is_valid_code = code in VALID_INDICES or (1 <= len(code) <= 15 and re.match(r'^[a-zA-Z0-9.\-]+$', code))
    if not is_valid_code:
        raise HTTPException(status_code=400, detail="유효한 종목 코드 또는 티커를 입력해주세요.")
    try:
        return get_cached_or_fetch(f"chart_{code}", lambda: fetch_stock_chart(code))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# 정적 파일 호스팅
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8080, reload=True)
