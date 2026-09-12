// ---------------------------------------------------------------------------
// Metrc v2 — Transfers & Transfer Templates (reads + write-back)
// ---------------------------------------------------------------------------
//
// Typed helpers over the core client for the Transfers domain. Every payload
// shape and endpoint here was validated live in the MI sandbox (07-01) while
// completing the Proficiency Evaluation's write sections. The builders encode
// the non-obvious rules so a call constructed from code succeeds first try:
//
//  - External incoming: TransferTypeName "External Cannabinoids" at the TOP
//    level of each object AND inside each destination; ExternalId must be null.
//  - Outgoing templates: licensed transfer types require a destination gross
//    weight (GrossWeight + GrossUnitOfWeightName); Packages may be empty.
//  - PUT id fields differ: TransferId (external incoming) vs TransferTemplateId
//    (templates).
// ---------------------------------------------------------------------------

import { getMetrcConfig, metrcDelete, metrcGet, metrcGetPdf, metrcPost, metrcPut, type MetrcResult } from "./metrcClient";
import { MetrcPaths, MetrcPutIdField, MetrcTransferTypes } from "./metrcEndpoints";

// --- Response shapes (loosely typed; Metrc adds fields by state/version) -----

export type MetrcPaged<T> = {
  Data: T[];
  Total: number;
  TotalRecords: number;
  PageSize: number;
  RecordsOnPage: number;
  Page: number;
  TotalPages: number;
  [k: string]: unknown;
};

export type MetrcTransfer = {
  Id: number;
  ManifestNumber: string;
  DeliveryId: number;
  ShipmentTypeName: string | null;
  ShipperFacilityLicenseNumber: string | null;
  RecipientFacilityLicenseNumber: string | null;
  PackageCount: number;
  IsVoided: boolean;
  LastModified: string;
  [k: string]: unknown;
};

export type MetrcTransferType = {
  Name: string;
  TransactionType: string;
  ForLicensedShipments: boolean;
  ForExternalIncomingShipments: boolean;
  ForExternalOutgoingShipments: boolean;
  RequiresDestinationGrossWeight: boolean;
  [k: string]: unknown;
};

export type MetrcDeliveryPackage = {
  PackageId: number | null;
  PackageLabel: string;
  ItemId: number;
  ProductName: string;
  ShippedQuantity: number;
  ShippedUnitOfMeasureName: string;
  [k: string]: unknown;
};

export type MetrcWholesalePackage = {
  PackageId: number | null;
  PackageLabel: string;
  ShipperWholesalePrice: number | null;
  ReceiverWholesalePrice: number | null;
  [k: string]: unknown;
};

// Resolve the license: explicit arg wins, else the configured default.
function license(explicit?: string): string | undefined {
  return explicit ?? getMetrcConfig()?.licenseNumber ?? undefined;
}

// --- Reads -------------------------------------------------------------------

export function getIncomingTransfers(
  opts?: { licenseNumber?: string; lastModifiedStart?: string; lastModifiedEnd?: string },
): Promise<MetrcResult<MetrcPaged<MetrcTransfer>>> {
  return metrcGet(MetrcPaths.transfersIncoming, {
    query: {
      licenseNumber: license(opts?.licenseNumber),
      lastModifiedStart: opts?.lastModifiedStart,
      lastModifiedEnd: opts?.lastModifiedEnd,
    },
  });
}

export function getOutgoingTransfers(
  opts?: { licenseNumber?: string; lastModifiedStart?: string; lastModifiedEnd?: string },
): Promise<MetrcResult<MetrcPaged<MetrcTransfer>>> {
  return metrcGet(MetrcPaths.transfersOutgoing, {
    query: {
      licenseNumber: license(opts?.licenseNumber),
      lastModifiedStart: opts?.lastModifiedStart,
      lastModifiedEnd: opts?.lastModifiedEnd,
    },
  });
}

export function getRejectedTransfers(
  opts?: { licenseNumber?: string; lastModifiedStart?: string; lastModifiedEnd?: string },
): Promise<MetrcResult<MetrcPaged<MetrcTransfer>>> {
  return metrcGet(MetrcPaths.transfersRejected, {
    query: {
      licenseNumber: license(opts?.licenseNumber),
      lastModifiedStart: opts?.lastModifiedStart,
      lastModifiedEnd: opts?.lastModifiedEnd,
    },
  });
}

export function getTransferTypes(licenseNumber?: string): Promise<MetrcResult<MetrcPaged<MetrcTransferType>>> {
  return metrcGet(MetrcPaths.transferTypes, { query: { licenseNumber: license(licenseNumber) } });
}

/** Fetch the OFFICIAL Metrc manifest PDF by manifest number (returns raw bytes). */
export function getManifestPdf(manifestNumber: string | number, licenseNumber?: string) {
  const lic = license(licenseNumber);
  const q = lic ? `?licenseNumber=${encodeURIComponent(lic)}` : "";
  return metrcGetPdf(`${MetrcPaths.manifestPdf(manifestNumber)}${q}`);
}

export function getDeliveryPackages(
  deliveryId: number | string,
  licenseNumber?: string,
): Promise<MetrcResult<MetrcPaged<MetrcDeliveryPackage>>> {
  return metrcGet(MetrcPaths.deliveryPackages(deliveryId), { query: { licenseNumber: license(licenseNumber) } });
}

export function getDeliveryPackagesWholesale(
  deliveryId: number | string,
  licenseNumber?: string,
): Promise<MetrcResult<MetrcPaged<MetrcWholesalePackage>>> {
  return metrcGet(MetrcPaths.deliveryPackagesWholesale(deliveryId), {
    query: { licenseNumber: license(licenseNumber) },
  });
}

/** OUTGOING-ONLY per Metrc. Returns empty for an incoming transfer id. */
export function getTransferDeliveries(
  transferId: number | string,
  licenseNumber?: string,
): Promise<MetrcResult<MetrcPaged<Record<string, unknown>>>> {
  return metrcGet(MetrcPaths.transferDeliveries(transferId), { query: { licenseNumber: license(licenseNumber) } });
}

export function getOutgoingTemplates(
  opts?: { licenseNumber?: string; lastModifiedStart?: string; lastModifiedEnd?: string },
): Promise<MetrcResult<MetrcPaged<MetrcTransfer>>> {
  // NOTE: templates/outgoing — the /transfers/v2/templates path 404s.
  return metrcGet(MetrcPaths.templatesOutgoing, {
    query: {
      licenseNumber: license(opts?.licenseNumber),
      lastModifiedStart: opts?.lastModifiedStart,
      lastModifiedEnd: opts?.lastModifiedEnd,
    },
  });
}

export function getTemplateDeliveries(
  templateId: number | string,
  licenseNumber?: string,
): Promise<MetrcResult<MetrcPaged<Record<string, unknown>>>> {
  return metrcGet(MetrcPaths.templateDeliveries(templateId), { query: { licenseNumber: license(licenseNumber) } });
}

// --- Write payload builders --------------------------------------------------

export type TransporterInput = {
  transporterFacilityLicenseNumber: string;
  driverName?: string;
  driverOccupationalLicenseNumber?: string;
  driverLicenseNumber?: string;
  phoneNumberForQuestions?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleLicensePlateNumber?: string;
  estimatedDepartureDateTime?: string;
  estimatedArrivalDateTime?: string;
};

function buildTransporter(t: TransporterInput, depart?: string, arrive?: string): Record<string, unknown> {
  return {
    TransporterFacilityLicenseNumber: t.transporterFacilityLicenseNumber,
    DriverOccupationalLicenseNumber: t.driverOccupationalLicenseNumber ?? null,
    DriverName: t.driverName ?? null,
    DriverLicenseNumber: t.driverLicenseNumber ?? null,
    PhoneNumberForQuestions: t.phoneNumberForQuestions ?? null,
    VehicleMake: t.vehicleMake ?? null,
    VehicleModel: t.vehicleModel ?? null,
    VehicleLicensePlateNumber: t.vehicleLicensePlateNumber ?? null,
    EstimatedDepartureDateTime: t.estimatedDepartureDateTime ?? depart ?? null,
    EstimatedArrivalDateTime: t.estimatedArrivalDateTime ?? arrive ?? null,
  };
}

export type ExternalIncomingPackageInput = {
  itemName: string;
  quantity: number;
  unitOfMeasureName: string;
  packagedDate?: string;
  grossWeight?: number | null;
  grossUnitOfWeightName?: string | null;
  wholesalePrice?: number | null;
  isFinishedGood?: boolean;
};

export type ExternalIncomingInput = {
  shipperLicenseNumber: string;
  shipperName: string;
  recipientLicenseNumber: string;
  /** Defaults to "External Cannabinoids" — the only MI external-incoming type. */
  transferTypeName?: string;
  plannedRoute?: string;
  estimatedDepartureDateTime?: string;
  estimatedArrivalDateTime?: string;
  shipperMainPhoneNumber?: string;
  shipperAddress1?: string;
  shipperAddressCity?: string;
  shipperAddressState?: string;
  shipperAddressPostalCode?: string;
  transporters?: TransporterInput[];
  packages: ExternalIncomingPackageInput[];
};

/**
 * Builds the POST/PUT body for an external incoming transfer (an array of one
 * object). TransferTypeName sits at the top level (this is what Metrc's
 * validator checks — omitting it gives "Transfer Type Name not specified") and
 * is repeated in the destination. ExternalId is forced null (the External
 * Cannabinoids type cannot record an external identifier).
 */
export function buildExternalIncomingPayload(input: ExternalIncomingInput): Record<string, unknown>[] {
  const type = input.transferTypeName ?? MetrcTransferTypes.externalIncoming;
  const depart = input.estimatedDepartureDateTime;
  const arrive = input.estimatedArrivalDateTime;
  const transporters = (input.transporters ?? []).map((t) => buildTransporter(t, depart, arrive));

  return [
    {
      ShipperLicenseNumber: input.shipperLicenseNumber,
      ShipperName: input.shipperName,
      ShipperMainPhoneNumber: input.shipperMainPhoneNumber ?? null,
      ShipperAddress1: input.shipperAddress1 ?? null,
      ShipperAddress2: null,
      ShipperAddressCity: input.shipperAddressCity ?? null,
      ShipperAddressState: input.shipperAddressState ?? null,
      ShipperAddressPostalCode: input.shipperAddressPostalCode ?? null,
      TransferTypeName: type,
      ExternalId: null,
      Destinations: [
        {
          RecipientLicenseNumber: input.recipientLicenseNumber,
          TransferTypeName: type,
          PlannedRoute: input.plannedRoute ?? null,
          EstimatedDepartureDateTime: depart ?? null,
          EstimatedArrivalDateTime: arrive ?? null,
          GrossWeight: null,
          GrossUnitOfWeightId: null,
          Transporters: transporters,
          Packages: input.packages.map((p) => ({
            ItemName: p.itemName,
            Quantity: p.quantity,
            UnitOfMeasureName: p.unitOfMeasureName,
            PackagedDate: p.packagedDate ?? null,
            GrossWeight: p.grossWeight ?? null,
            GrossUnitOfWeightName: p.grossUnitOfWeightName ?? null,
            WholesalePrice: p.wholesalePrice ?? null,
            ExternalId: null,
            IsFinishedGood: p.isFinishedGood ?? false,
          })),
        },
      ],
    },
  ];
}

export type TemplatePackageInput = { packageLabel: string; wholesalePrice?: number | null };

export type TemplateOutgoingInput = {
  name: string;
  recipientLicenseNumber: string;
  /** Defaults to "AU Affiliated Transfer" — a licensed type. Must be ForLicensedShipments. */
  transferTypeName?: string;
  plannedRoute?: string;
  estimatedDepartureDateTime?: string;
  estimatedArrivalDateTime?: string;
  /** REQUIRED for licensed transfer types (RequiresDestinationGrossWeight:true). */
  grossWeight: number;
  grossUnitOfWeightName: string;
  transporters?: TransporterInput[];
  packages?: TemplatePackageInput[];
};

/**
 * Builds the POST/PUT body for an outgoing transfer template (array of one).
 * Licensed types REQUIRE the destination gross weight; Packages may be empty.
 */
export function buildTemplateOutgoingPayload(input: TemplateOutgoingInput): Record<string, unknown>[] {
  const type = input.transferTypeName ?? MetrcTransferTypes.outgoingLicensedDefault;
  const depart = input.estimatedDepartureDateTime;
  const arrive = input.estimatedArrivalDateTime;
  const transporters = (input.transporters ?? []).map((t) => buildTransporter(t, depart, arrive));

  return [
    {
      Name: input.name,
      TransferTypeName: type,
      Destinations: [
        {
          RecipientLicenseNumber: input.recipientLicenseNumber,
          TransferTypeName: type,
          PlannedRoute: input.plannedRoute ?? null,
          EstimatedDepartureDateTime: depart ?? null,
          EstimatedArrivalDateTime: arrive ?? null,
          GrossWeight: input.grossWeight,
          GrossUnitOfWeightName: input.grossUnitOfWeightName,
          Transporters: transporters,
          Packages: (input.packages ?? []).map((p) => ({
            PackageLabel: p.packageLabel,
            WholesalePrice: p.wholesalePrice ?? null,
          })),
        },
      ],
    },
  ];
}

// --- Writes ------------------------------------------------------------------

export type MetrcCreateResult = { Ids: number[]; Warnings: unknown };

export function createExternalIncoming(
  input: ExternalIncomingInput,
  licenseNumber?: string,
): Promise<MetrcResult<MetrcCreateResult>> {
  return metrcPost(MetrcPaths.externalIncoming, {
    query: { licenseNumber: license(licenseNumber) },
    body: buildExternalIncomingPayload(input),
  });
}

/** Update an external incoming transfer. Injects `TransferId` (the required id field). */
export function updateExternalIncoming(
  transferId: number,
  input: ExternalIncomingInput,
  licenseNumber?: string,
): Promise<MetrcResult<undefined>> {
  const body = buildExternalIncomingPayload(input).map((obj) => ({
    [MetrcPutIdField.externalIncoming]: transferId,
    ...obj,
  }));
  return metrcPut(MetrcPaths.externalIncoming, { query: { licenseNumber: license(licenseNumber) }, body });
}

export function deleteExternalIncoming(transferId: number, licenseNumber?: string): Promise<MetrcResult<undefined>> {
  return metrcDelete(MetrcPaths.externalIncomingById(transferId), {
    query: { licenseNumber: license(licenseNumber) },
  });
}

export function createTemplateOutgoing(
  input: TemplateOutgoingInput,
  licenseNumber?: string,
): Promise<MetrcResult<MetrcCreateResult>> {
  return metrcPost(MetrcPaths.templatesOutgoing, {
    query: { licenseNumber: license(licenseNumber) },
    body: buildTemplateOutgoingPayload(input),
  });
}

/** Update an outgoing template. Injects `TransferTemplateId` (the required id field). */
export function updateTemplateOutgoing(
  templateId: number,
  input: TemplateOutgoingInput,
  licenseNumber?: string,
): Promise<MetrcResult<undefined>> {
  const body = buildTemplateOutgoingPayload(input).map((obj) => ({
    [MetrcPutIdField.template]: templateId,
    ...obj,
  }));
  return metrcPut(MetrcPaths.templatesOutgoing, { query: { licenseNumber: license(licenseNumber) }, body });
}
