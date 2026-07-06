function assertFiniteNumber(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
}

function assertInteger(name, value) {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
}

function validateFireInputs(input) {
  assertFiniteNumber("age", input.age);
  assertFiniteNumber("annual_spend", input.annualSpend);
  assertFiniteNumber("current_investments", input.currentInvestments);
  assertFiniteNumber("expected_return_rate", input.expectedReturnRate);
  assertFiniteNumber("inflation_rate", input.inflationRate);
  assertFiniteNumber("annual_income", input.annualIncome);
  assertFiniteNumber("withdrawal_rate", input.withdrawalRate);
  assertFiniteNumber("max_age", input.maxAge);

  assertInteger("age", input.age);
  assertInteger("max_age", input.maxAge);

  if (input.age < 0) throw new Error("age must be >= 0");
  if (input.annualSpend < 0) throw new Error("annual_spend must be >= 0");
  if (input.currentInvestments < 0) throw new Error("current_investments must be >= 0");
  if (input.annualIncome < 0) throw new Error("annual_income must be >= 0");
  if (input.withdrawalRate < 0.005 || input.withdrawalRate > 0.1) {
    throw new Error("withdrawal_rate must be between 0.5% and 10%");
  }
  if (input.expectedReturnRate < -0.5 || input.expectedReturnRate > 0.5) {
    throw new Error("expected_return_rate must be between -50% and 50%");
  }
  if (input.inflationRate < -0.05 || input.inflationRate > 0.2) {
    throw new Error("inflation_rate must be between -5% and 20%");
  }
  if (input.maxAge <= input.age) throw new Error("max_age must be greater than age");

  if (input.incomeGrowthRate === null || input.incomeGrowthRate === undefined) {
    input.incomeGrowthRate = input.inflationRate;
  }

  assertFiniteNumber("income_growth_rate", input.incomeGrowthRate);

  if (input.incomeGrowthRate < -0.2 || input.incomeGrowthRate > 0.3) {
    throw new Error("income_growth_rate must be between -20% and 30%");
  }

  return input;
}

function validateMonteCarloParams(params) {
  assertFiniteNumber("iterations", params.iterations);
  assertFiniteNumber("return_std_dev", params.returnStdDev);
  assertFiniteNumber("inflation_std_dev", params.inflationStdDev);
  assertInteger("iterations", params.iterations);

  if (params.seed !== null && params.seed !== undefined) {
    assertFiniteNumber("seed", params.seed);
    assertInteger("seed", params.seed);
  }

  if (params.iterations <= 0) throw new Error("iterations must be > 0");
  if (params.iterations > 10000) throw new Error("iterations must be <= 10000");
  if (params.returnStdDev < 0) throw new Error("return_std_dev must be >= 0");
  if (params.inflationStdDev < 0) throw new Error("inflation_std_dev must be >= 0");
  if (params.returnStdDev > 0.6) throw new Error("return_std_dev must be <= 60%");
  if (params.inflationStdDev > 0.1) throw new Error("inflation_std_dev must be <= 10%");
  return params;
}

module.exports = {
  validateFireInputs,
  validateMonteCarloParams,
};
