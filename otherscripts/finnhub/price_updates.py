#Trades - Last Price Updates
#https://finnhub.io/docs/api/websocket-trades

#https://pypi.org/project/websocket_client/
import websocket
from datetime import datetime
import json

#Feature 	        Free Tier	    Basic ($49.99/mo)	All-In-One ($3,000/mo)
#Websocket Symbols	50 symbols	    250 symbols	        Unlimited
#API Rate Limit	    60 calls/min	150 calls/min	    900+ calls/min
#Market Coverage	US Only	        US + Selected       Gl

TOKEN = "d6cce0hr01qsiik1mr2gd6cce0hr01qsiik1mr30"

def on_message_bak(ws, message):

    data = json.loads(message)
    
    if data.get("type") == "trade":
        print("\n" + "─" * 45)
        for trade in data.get("data", []):
            symbol    = trade.get("s", "N/A")
            price     = trade.get("p", 0)
            volume    = trade.get("v", 0)
            timestamp = trade.get("t", 0)
            conditions = trade.get("c", [])
            
            dt = datetime.fromtimestamp(timestamp / 1000).strftime("%H:%M:%S")
            
            print(f"  📈 {symbol:<10} ${price:<10.4f}  Vol: {volume:<8}  {dt}")
            if conditions:
                print(f"     Conditions: {conditions}")
        print("─" * 45)
    
    elif data.get("type") == "ping":
        print("♻️  [ping]")
    
    else:
        print(f"[{data.get('type', 'unknown')}] {data}")

def on_message(ws, message):
    data = json.loads(message)
    seen = set()
    if data.get("type") == "trade":
        print("\n" + "─" * 72)
        for trade in data.get("data", []):
            key = (trade.get("s"), trade.get("p"), trade.get("t"), trade.get("v"))
            if key in seen:
                continue
            seen.add(key)
            symbol     = trade.get("s", "N/A")
            price      = trade.get("p", 0)
            volume     = trade.get("v", 0)
            timestamp  = trade.get("t", 0)
            conditions = trade.get("c", [])
            
            dt = datetime.fromtimestamp(timestamp / 1000).strftime("%H:%M:%S")
            cond_str = f"  Cond: {conditions}" if conditions else ""
            
            print(f"  📈 {symbol:<8} ${price:<8.4f}  Vol: {volume:<8}  {dt}{cond_str}")
        print("─" * 55)
    
    elif data.get("type") == "ping":
        print("♻️  [ping]")
    
    else:
        print(f"[{data.get('type', 'unknown')}] {data}")

def on_error(ws, error):
    print(error)

def on_close(ws):
    print("### closed ###")

def on_open(ws):
    ws.send('{"type":"subscribe","symbol":"RXT"}')
    ws.send('{"type":"subscribe","symbol":"MGRX"}')
    ws.send('{"type":"subscribe","symbol":"AAPL"}')
    #ws.send('{"type":"subscribe","symbol":"BINANCE:BTCUSDT"}')

if __name__ == "__main__":
    websocket.enableTrace(False)
    ws = websocket.WebSocketApp(f"wss://ws.finnhub.io?token={TOKEN}",
                              on_message = on_message,
                              on_error = on_error,
                              on_close = on_close)
    ws.on_open = on_open
    ws.run_forever()
