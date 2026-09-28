export const merchantProducts = ["collections", "payouts", "sms", "airtime"] as const;

export type MerchantProduct = (typeof merchantProducts)[number];

export const kybRequirements = [
  "business_registration",
  "contact_person",
  "director_id",
  "proof_of_address",
  "tax_certificate"
] as const;

export type KybRequirement = (typeof kybRequirements)[number];

export const productKybRequirements: Record<MerchantProduct, readonly KybRequirement[]> = {
  airtime: ["business_registration", "contact_person"],
  collections: ["business_registration", "contact_person", "director_id", "proof_of_address"],
  payouts: [
    "business_registration",
    "contact_person",
    "director_id",
    "proof_of_address",
    "tax_certificate"
  ],
  sms: ["business_registration", "contact_person"]
};

export function kybRequirementsForProducts(
  products: readonly MerchantProduct[]
): KybRequirement[] {
  const required = new Set<KybRequirement>();
  for (const product of products) {
    for (const requirement of productKybRequirements[product]) {
      required.add(requirement);
    }
  }

  return kybRequirements.filter((requirement) => required.has(requirement));
}
