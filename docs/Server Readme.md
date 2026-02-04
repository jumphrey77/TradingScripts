## ✅ 1️⃣ Test Flask API directly (no React yet)

First make sure Python server is running.

From your scanner folder:

```javascript
python server.py
```

You should see:

```javascript
🔥 Momentum Scanner API running on http://localhost:5000
🔄 Running scheduled scan...
```


---

### 🔍 Open in browser:

Go to:

```javascript
http://localhost:5000/api/scan
```


---

### Expected:

• JSON array \n • or`[]`if first scan not finished yet \n • refresh every minute → numbers change

If this does NOT work → stop here and tell me the error.

## 2️⃣ Run React dashboard

In a second terminal:

```javascript
cd momentum-dashboard
npm run dev
```

## 🧪 Bonus quick test (PowerShell)

You can test API without browser:

```javascript
curl http://localhost:5000/api/scan
```

or:

```javascript
Invoke-WebRequest http://localhost:5000/api/scan | Select-Object -Expand Content
```


---


