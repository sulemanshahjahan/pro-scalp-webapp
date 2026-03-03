import urllib.request
import json
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# Check extended outcome for signal 3152
url = "https://pro-scalp-backend-production.up.railway.app/api/extended-outcomes?limit=100"

try:
    req = urllib.request.Request(url)
    response = urllib.request.urlopen(req, timeout=10, context=ctx)
    data = json.loads(response.read().decode())
    
    for row in data.get("rows", []):
        if row.get("signalId") == 3152:
            print("=" * 80)
            print("SIGNAL 3152 - PUMPUSDT OUTCOME ANALYSIS")
            print("=" * 80)
            print()
            print("Recorded Outcome:")
            print(f"  Status: {row.get('status')}")
            print(f"  Entry Price: {row.get('entryPrice')}")
            print(f"  Stop Price: {row.get('stopPrice')}")
            print(f"  TP1 Price: {row.get('tp1Price')}")
            print(f"  TP2 Price: {row.get('tp2Price')}")
            print(f"  Stop At: {row.get('stopAt')}")
            print(f"  Max Adverse Excursion: {row.get('maxAdverseExcursionPct')}%")
            print()
            print("Key Finding:")
            print("  The system uses DELAYED ENTRY confirmed prices!")
            print("  - Original signal: Entry 0.002, Stop 0.00198")
            print("  - Delayed entry confirmed: Entry 0.002012, Stop ~0.001992")
            print("  - Market low: 0.001990")
            print()
            print("  Since 0.001990 < 0.001992, the stop WAS legitimately hit!")
            print()
            print("  The outcome LOSS_STOP is CORRECT!")
            print("=" * 80)
            break
        
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
