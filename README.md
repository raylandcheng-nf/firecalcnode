# FIRE Monte Carlo Retirement Estimator (Node.js)

Node.js replication of the Python FIRE + Monte Carlo app.

## Features
- Deterministic FIRE projection based on:
  - `target = annual_spend / withdrawal_rate`
  - `next_portfolio = (portfolio + annual_savings) * (1 + expected_return_rate)`
- Post-retirement Monte Carlo longevity simulation to ages 75/80/85/90/95/100
- Probability portfolio never runs out through age 120

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

## URL Parameters

The web app supports optional query parameters to prefill all form fields.

Supported parameters:
- `age`
- `spend`
- `investments`
- `income`
- `return_rate`
- `inflation_rate`
- `withdrawal_rate`
- `max_age`
- `income_growth_rate` (optional)
- `iterations`
- `return_std_dev`
- `inflation_std_dev`
- `seed` (optional)

Example prefilled URL:

```text
http://127.0.0.1:8080/?age=45&spend=62000&investments=300000&income=140000&return_rate=6.5&inflation_rate=2.2&withdrawal_rate=3.8&max_age=90&income_growth_rate=2.4&iterations=2500&return_std_dev=12&inflation_std_dev=1.3&seed=7
```

After successful submission, the app uses a Post/Redirect/Get flow and redirects to a URL containing the submitted values plus `run=1`.

Example:

```text
/?age=41&spend=55000&investments=240000&return_rate=6.8&inflation_rate=2.4&income=120000&withdrawal_rate=4&max_age=88&income_growth_rate=2.2&iterations=1500&return_std_dev=14&inflation_std_dev=1.1&seed=11&run=1
```

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
