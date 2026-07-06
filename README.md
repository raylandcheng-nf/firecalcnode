# FIRE Monte Carlo Retirement Estimator (Node.js)

Node.js replication of the Python FIRE + Monte Carlo app.

## Features
- Deterministic FIRE projection based on:
  - `target = annual_spend / withdrawal_rate`
  - `next_portfolio = (portfolio + annual_savings) * (1 + expected_return_rate)`
- Post-retirement Monte Carlo longevity simulation to ages 75/80/85/90/95/100
- Probability portfolio never runs out through age 200

## Install

```powershell
cd node
npm install
```

## Configure

Create `.env` in the `node` folder (you can copy `.env.example`):

## Run Web App

```powershell
npm start
```

Then open `http://127.0.0.1:8080`.

## Run CLI

```powershell
npm run cli -- --age 32 --spend 50000 --investments 180000 --return-rate 7 --inflation-rate 2.5 --income 95000 --withdrawal-rate 4 --iterations 5000 --return-std-dev 15 --inflation-std-dev 1
```

## Build For Deployment

Generate a deployment artifact in the `dist` folder:

```powershell
npm run build
```

This copies runtime files to `dist`:
- `src/`
- `views/`
- `package.json`
- `package-lock.json`
- `.env.example`

Deploy using the `dist` folder:

```powershell
cd dist
npm ci --omit=dev
npm start
```
