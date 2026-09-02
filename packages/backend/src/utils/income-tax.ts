/**
 * German income tax tariff 2025 (§ 32a EStG as amended by the
 * Steuerfortentwicklungsgesetz) plus Solidaritätszuschlag. Used only for the
 * dashboard tax-reserve estimate — deliberately ignores church tax and
 * deduction specifics beyond what the caller passes in as zvE.
 */

const GRUNDFREIBETRAG = 12_096;
const ZONE2_END = 17_443;
const ZONE3_END = 68_480;
const ZONE4_END = 277_825;

/** Unrounded base tariff on a (full-euro) zvE. */
function baseTariff(zvE: number): number {
  if (zvE <= GRUNDFREIBETRAG) return 0;
  if (zvE <= ZONE2_END) {
    const y = (zvE - GRUNDFREIBETRAG) / 10_000;
    return (932.3 * y + 1_400) * y;
  }
  if (zvE <= ZONE3_END) {
    const z = (zvE - ZONE2_END) / 10_000;
    return (176.64 * z + 2_397) * z + 1_015.13;
  }
  if (zvE <= ZONE4_END) return 0.42 * zvE - 10_911.92;
  return 0.45 * zvE - 19_246.67;
}

/** Income tax 2025, truncated to full euros. Splitting doubles the truncated
 *  tax on half the income (§ 32a Abs. 5 EStG). */
export function incomeTax2025(zvE: number, jointAssessment = false): number {
  const income = Math.max(0, Math.floor(zvE));
  if (jointAssessment) return 2 * Math.floor(baseTariff(income / 2));
  return Math.floor(baseTariff(income));
}

const SOLI_RATE = 0.055;
const SOLI_FREIGRENZE = 19_950;
const SOLI_MILDERUNG_RATE = 0.119;

/** Solidaritätszuschlag 2025 on an income-tax amount, truncated to full euros. */
export function soli2025(incomeTax: number, jointAssessment = false): number {
  const freigrenze = jointAssessment ? 2 * SOLI_FREIGRENZE : SOLI_FREIGRENZE;
  if (incomeTax <= freigrenze) return 0;
  const soli = Math.min(SOLI_RATE * incomeTax, SOLI_MILDERUNG_RATE * (incomeTax - freigrenze));
  return Math.floor(soli);
}

/**
 * The additional tax (income tax + Soli) caused by side income on top of a
 * salary: tax(salary + profit) − tax(salary). Never negative.
 */
export function extraTaxOnSideIncome(
  salaryZvE: number,
  sideProfit: number,
  jointAssessment: boolean,
): number {
  const withTax = incomeTax2025(salaryZvE + sideProfit, jointAssessment);
  const withoutTax = incomeTax2025(salaryZvE, jointAssessment);
  const total =
    withTax +
    soli2025(withTax, jointAssessment) -
    (withoutTax + soli2025(withoutTax, jointAssessment));
  return Math.max(0, total);
}
