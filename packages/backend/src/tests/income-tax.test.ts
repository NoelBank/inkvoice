import { describe, expect, test } from "bun:test";
import { extraTaxOnSideIncome, incomeTax2025, soli2025 } from "../utils/income-tax";

// Reference values for the 2025 base tariff (§ 32a EStG as amended by the
// Steuerfortentwicklungsgesetz): Grundfreibetrag 12.096 €, zone boundaries
// 17.443 / 68.480 / 277.825 €. Expected amounts follow the statutory formula
// with the result truncated to full euros.
describe("incomeTax2025 (Grundtarif)", () => {
  test("is zero up to the Grundfreibetrag", () => {
    expect(incomeTax2025(0)).toBe(0);
    expect(incomeTax2025(12_096)).toBe(0);
  });

  test("first progression zone", () => {
    // y = (14.000 - 12.096) / 10.000 = 0,1904
    // (932,30 * y + 1.400) * y = 300,36 → 300
    expect(incomeTax2025(14_000)).toBe(300);
  });

  test("second progression zone", () => {
    // z = (30.000 - 17.443) / 10.000 = 1,2557
    // (176,64 * z + 2.397) * z + 1.015,13 = 4.303,57 → 4.303
    expect(incomeTax2025(30_000)).toBe(4_303);
    // z = (60.000 - 17.443) / 10.000 = 4,2557
    // (176,64 * z + 2.397) * z + 1.015,13 = 14.415,26 → 14.415
    expect(incomeTax2025(60_000)).toBe(14_415);
  });

  test("42% zone", () => {
    // 0,42 * 100.000 - 10.911,92 = 31.088,08 → 31.088
    expect(incomeTax2025(100_000)).toBe(31_088);
  });

  test("45% zone (Reichensteuer)", () => {
    // 0,45 * 300.000 - 19.246,67 = 115.753,33 → 115.753
    expect(incomeTax2025(300_000)).toBe(115_753);
  });

  test("zones join continuously", () => {
    // Both formulas yield ~17.850 € at the 68.480/68.481 boundary.
    expect(incomeTax2025(68_481) - incomeTax2025(68_480)).toBeLessThanOrEqual(1);
  });

  test("truncates fractional zvE to full euros", () => {
    expect(incomeTax2025(30_000.99)).toBe(incomeTax2025(30_000));
  });

  test("splitting tariff doubles the tax on half the income", () => {
    expect(incomeTax2025(60_000, true)).toBe(2 * incomeTax2025(30_000));
  });
});

describe("soli2025", () => {
  test("zero below the Freigrenze (19.950 € tax, single)", () => {
    expect(soli2025(19_950)).toBe(0);
    expect(soli2025(0)).toBe(0);
  });

  test("Milderungszone caps at 11,9% of the amount above the Freigrenze", () => {
    // 20.950: min(5,5% * 20.950 = 1.152,25; 11,9% * 1.000 = 119) = 119
    expect(soli2025(20_950)).toBe(119);
  });

  test("full 5,5% once past the Milderungszone", () => {
    expect(soli2025(40_000)).toBe(2_200);
  });

  test("joint assessment doubles the Freigrenze", () => {
    expect(soli2025(39_900, true)).toBe(0);
    expect(soli2025(20_950, true)).toBe(0);
  });
});

describe("extraTaxOnSideIncome", () => {
  test("is the tax delta caused by the side income, incl. Soli", () => {
    const withSide = incomeTax2025(90_000);
    const withoutSide = incomeTax2025(60_000);
    const expected = withSide + soli2025(withSide) - (withoutSide + soli2025(withoutSide));
    expect(extraTaxOnSideIncome(60_000, 30_000, false)).toBe(expected);
  });

  test("zero when there is no side income", () => {
    expect(extraTaxOnSideIncome(60_000, 0, false)).toBe(0);
  });

  test("never negative (a side loss does not create a refund estimate)", () => {
    expect(extraTaxOnSideIncome(60_000, -5_000, false)).toBe(0);
  });

  test("with no salary the side income alone is taxed from zero", () => {
    expect(extraTaxOnSideIncome(0, 30_000, false)).toBe(incomeTax2025(30_000));
  });
});
