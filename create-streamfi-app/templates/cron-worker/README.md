# StreamFi Cron Worker

A tiny scheduled worker that checks a recipient's withdrawable balance every minute and auto-withdraws.

```bash
npm install
npm start
```

Copy `.env.example` to `.env` and fill in your factory address, a funded secret key, and the recipient to watch.
