/**
 * The canonical quote request.
 *
 * One rule is structural rather than conventional: `creditAuthorization` has no
 * default and no inferred value. It must come from the client, and the submit
 * gate refuses outright without it, because submitting can trigger credit and
 * underwriting reports on a real person.
 */

import { z } from 'zod';

const DateString = z
  .string()
  .regex(/^(?:\d{1,2}[/-]\d{1,2}[/-](?:19|20)\d{2}|(?:19|20)\d{2}-\d{1,2}-\d{1,2})$/, 'expected MM/DD/YYYY or YYYY-MM-DD');

const StateCode = z.string().length(2).regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase());

export const GenderSchema = z.enum(['Male', 'Female', 'Non-Binary', 'Unknown']);
export const MaritalStatusSchema = z.enum(['Single', 'Married', 'Divorced', 'Widowed', 'Separated', 'Domestic Partner']);

export const PersonSchema = z.object({
  firstName: z.string().min(1),
  middleInitial: z.string().max(4).optional(),
  lastName: z.string().min(1),
  suffix: z.string().optional(),
  gender: GenderSchema.optional(),
  dateOfBirth: DateString.optional(),
  maritalStatus: MaritalStatusSchema.optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  education: z.string().optional(),
  industry: z.string().optional(),
  occupation: z.string().optional(),
});

export const AddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  unit: z.string().optional(),
  city: z.string().min(1),
  state: StateCode,
  postalCode: z.string().min(5),
  postalCodeSuffix: z.string().optional(),
  county: z.string().optional(),
  yearsAtAddress: z.number().int().min(0).optional(),
  monthsAtAddress: z.number().int().min(0).max(11).optional(),
});

export const DriverSchema = PersonSchema.extend({
  relationship: z.string().optional(),
  driversLicenseNumber: z.string().optional(),
  driversLicenseState: StateCode.optional(),
  driversLicenseStatus: z.string().optional(),
  ageFirstLicensed: z.number().int().min(14).max(90).optional(),
  goodStudent: z.boolean().optional(),
  suspensions: z.boolean().optional(),
  /** Free-form per-carrier ICQ answers keyed by selector. */
  carrierAnswers: z.record(z.string()).optional(),
});

export const VehicleSchema = z.object({
  vin: z.string().optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  subModel: z.string().optional(),
  use: z.string().optional(),
  oneWayMiles: z.number().int().min(1).optional(),
  daysPerWeek: z.number().int().min(1).max(7).optional(),
  weeksPerMonth: z.number().int().min(1).max(5).optional(),
  annualMiles: z.number().int().min(0).optional(),
  ownership: z.enum(['Owned', 'Leased', 'Financed']).optional(),
  purchaseDate: DateString.optional(),
  comprehensiveDeductible: z.string().optional(),
  collisionDeductible: z.string().optional(),
  towingAndLabor: z.string().optional(),
  extendedTransportation: z.string().optional(),
  fullGlass: z.boolean().optional(),
  carrierAnswers: z.record(z.string()).optional(),
});

export const PriorPolicySchema = z.object({
  carrier: z.string().optional(),
  expirationDate: DateString.optional(),
  liabilityLimits: z.string().optional(),
  policyTerm: z.string().optional(),
  premium: z.number().optional(),
  yearsWithCarrier: z.number().int().min(0).optional(),
  monthsWithCarrier: z.number().int().min(0).max(11).optional(),
  yearsContinuousCoverage: z.number().int().min(0).optional(),
  monthsContinuousCoverage: z.number().int().min(0).max(11).optional(),
});

export const AutoCoverageSchema = z.object({
  bodilyInjury: z.string().optional(),
  propertyDamage: z.string().optional(),
  uninsuredMotorist: z.string().optional(),
  underinsuredMotorist: z.string().optional(),
  medicalPayments: z.string().optional(),
  mnPipOption: z.string().optional(),
  mnPipDeductible: z.string().optional(),
  mnWorkLoss: z.string().optional(),
  applyToAllVehicles: z.boolean().optional(),
});

export const DwellingSchema = z.object({
  usage: z.string().optional(),
  occupancy: z.string().optional(),
  dwellingType: z.string().optional(),
  numberOfOccupants: z.number().int().min(1).optional(),
  stories: z.string().optional(),
  squareFeet: z.number().int().min(100).optional(),
  yearBuilt: z.number().int().min(1700).max(2100).optional(),
  construction: z.string().optional(),
  roofType: z.string().optional(),
  roofDesign: z.string().optional(),
  foundation: z.string().optional(),
  exteriorWalls: z.string().optional(),
  fullBaths: z.number().int().min(0).optional(),
  halfBaths: z.number().int().min(0).optional(),
  heating: z.string().optional(),
  garageType: z.string().optional(),
  hydrantDistance: z.string().optional(),
  protectionClass: z.string().optional(),
  /** Replacement cost from the RCE — never taken from EZLynx's prefill. */
  estimatedReplacementCost: z.number().int().positive().optional(),
  marketValue: z.number().int().positive().optional(),
  updates: z
    .object({
      roofYear: z.number().int().optional(),
      electricalYear: z.number().int().optional(),
      plumbingYear: z.number().int().optional(),
      heatingYear: z.number().int().optional(),
    })
    .optional(),
});

export const HomeCoverageSchema = z.object({
  dwelling: z.number().int().positive().optional(),
  otherStructures: z.string().optional(),
  personalProperty: z.string().optional(),
  lossOfUse: z.string().optional(),
  lossOfUseAmount: z.number().int().optional(),
  personalLiability: z.string().optional(),
  medicalPayments: z.string().optional(),
  allPerilsDeductible: z.string().optional(),
  policyFormType: z.string().optional(),
  endorsements: z.record(z.string()).optional(),
});

export const HouseholdQuestionsSchema = z.object({
  dogs: z.boolean().optional(),
  pool: z.boolean().optional(),
  trampoline: z.boolean().optional(),
  businessOnPremises: z.boolean().optional(),
  numberOfResidents: z.number().int().min(1).optional(),
});

/**
 * Explicit client authorisation for credit and underwriting reports.
 * No default, deliberately.
 */
export const CreditAuthorizationSchema = z.object({
  authorized: z.boolean(),
  obtainedFrom: z.string().min(1, 'record who gave authorisation'),
  obtainedOn: DateString,
  notes: z.string().optional(),
});

export const CarrierSelectionSchema = z.object({
  mode: z.enum(['all', 'all-preferred', 'all-non-preferred', 'explicit']).default('all'),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});

export const QuoteRequestSchema = z.object({
  accountId: z.string().regex(/^\d+$/, 'EZLynx account id is numeric'),
  ratingState: StateCode,
  effectiveDate: DateString.optional(),
  newPolicyTerm: z.string().optional(),
  quoteAsPackage: z.boolean().optional(),
  bridgeEmailToCarriers: z.boolean().optional(),

  applicant: PersonSchema,
  coApplicant: PersonSchema.optional(),
  address: AddressSchema,

  drivers: z.array(DriverSchema).default([]),
  vehicles: z.array(VehicleSchema).default([]),
  /** assignment[vehicleIndex][driverIndex] = percentage */
  driverVehicleAssignment: z.array(z.array(z.number().min(0).max(100))).optional(),

  priorAuto: PriorPolicySchema.optional(),
  priorHome: PriorPolicySchema.optional(),

  autoCoverage: AutoCoverageSchema.optional(),
  dwelling: DwellingSchema.optional(),
  homeCoverage: HomeCoverageSchema.optional(),
  household: HouseholdQuestionsSchema.optional(),

  carriers: z.object({ auto: CarrierSelectionSchema.optional(), home: CarrierSelectionSchema.optional() }).optional(),

  creditAuthorization: CreditAuthorizationSchema,

  /** Escape hatch for carrier questions we have not modelled: selector -> value. */
  carrierAnswers: z.record(z.string()).optional(),
});

export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;
export type Driver = z.infer<typeof DriverSchema>;
export type Vehicle = z.infer<typeof VehicleSchema>;
export type Dwelling = z.infer<typeof DwellingSchema>;
export type CreditAuthorization = z.infer<typeof CreditAuthorizationSchema>;

/** Partial shape used by the extractor before defaults and input are merged. */
export const PartialQuoteSchema = QuoteRequestSchema.deepPartial();
export type PartialQuote = z.infer<typeof PartialQuoteSchema>;

/**
 * What `extract` produces. Everything a quote needs except the account id,
 * which is supplied at run time via `--account`.
 */
export const DraftQuoteSchema = QuoteRequestSchema.extend({ accountId: z.string().optional() });
export type DraftQuote = z.infer<typeof DraftQuoteSchema>;

export function validateQuoteRequest(input: unknown): QuoteRequest {
  return QuoteRequestSchema.parse(input);
}

/** True when the run is allowed to submit to carriers. */
export function hasCreditAuthorization(quote: QuoteRequest): boolean {
  return quote.creditAuthorization.authorized === true;
}
