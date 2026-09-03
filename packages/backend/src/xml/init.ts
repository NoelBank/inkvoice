import { registerProfile } from "./profile-registry";
import { FacturxZugferdProfile } from "./profiles/facturx-zugferd";
import { XRechnungProfile } from "./profiles/xrechnung";

export function initXmlProfiles(): void {
  registerProfile(new FacturxZugferdProfile());
  registerProfile(new XRechnungProfile());
}
