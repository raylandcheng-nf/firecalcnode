const { validateFireInputs } = require("./validation");

function deterministicProjectionRows(input) {
  const data = validateFireInputs({ ...input });

  const age = data.age;
  const spend = data.annualSpend;
  const annualSavings = data.annualIncome - data.annualSpend;
  const target = spend > 0 ? spend / data.withdrawalRate : 0;

  let portfolio = data.currentInvestments;
  const rows = [];

  if (spend <= 0 || portfolio >= target) {
    const returnAmount = portfolio * data.expectedReturnRate;
    const afterReturn = portfolio + returnAmount;
    const endPortfolio = afterReturn + annualSavings;
    rows.push({
      year: 0,
      age,
      startPortfolio: portfolio,
      annualSavings,
      returnAmount,
      afterReturn,
      afterSavings: endPortfolio,
      endPortfolio,
      fireTarget: target,
      reachedFire: true,
    });
    return rows;
  }

  for (let years = 1; years <= data.maxAge - age; years += 1) {
    const startPortfolio = portfolio;
    const returnAmount = startPortfolio * data.expectedReturnRate;
    const afterReturn = startPortfolio + returnAmount;
    const endPortfolio = afterReturn + annualSavings;
    const afterSavings = endPortfolio;
    const reachedFire = endPortfolio >= target;

    rows.push({
      year: years,
      age: age + years,
      startPortfolio,
      annualSavings,
      afterReturn,
      afterSavings,
      returnAmount,
      endPortfolio,
      fireTarget: target,
      reachedFire,
    });

    portfolio = endPortfolio;
    if (reachedFire) break;
  }

  return rows;
}

function projectRetirement(input) {
  const data = validateFireInputs({ ...input });
  const age = data.age;
  const spend = data.annualSpend;
  const target = spend > 0 ? spend / data.withdrawalRate : 0;
  const rows = deterministicProjectionRows(data);
  const finalPortfolio = rows.length ? rows[rows.length - 1].endPortfolio : data.currentInvestments;

  if (spend <= 0) {
    return {
      retired: true,
      retirementAge: age,
      retirementYearsFromNow: 0,
      finalPortfolio,
      finalTarget: 0,
    };
  }

  if (data.currentInvestments >= target) {
    return {
      retired: true,
      retirementAge: age,
      retirementYearsFromNow: 0,
      finalPortfolio,
      finalTarget: target,
    };
  }

  if (rows.length && rows[rows.length - 1].reachedFire) {
    const row = rows[rows.length - 1];
    return {
      retired: true,
      retirementAge: row.age,
      retirementYearsFromNow: row.year,
      finalPortfolio,
      finalTarget: target,
    };
  }

  return {
    retired: false,
    retirementAge: null,
    retirementYearsFromNow: null,
    finalPortfolio,
    finalTarget: target,
  };
}

module.exports = {
  deterministicProjectionRows,
  projectRetirement,
};
