/** DVLA and DVSA answers in their published shapes, for the car's tests. */
/** DVLA VES v1.2.0's own example response, verbatim. */
export const VES_SAMPLE = {
  registrationNumber: "WN67DSO",
  taxStatus: "Untaxed",
  taxDueDate: "2017-12-25",
  artEndDate: "2007-12-25",
  motStatus: "No details held by DVLA",
  motExpiryDate: "2008-12-25",
  make: "ROVER",
  monthOfFirstDvlaRegistration: "2011-11",
  monthOfFirstRegistration: "2012-12",
  yearOfManufacture: 2004,
  engineCapacity: 1796,
  co2Emissions: 0,
  fuelType: "PETROL",
  markedForExport: true,
  colour: "Blue",
  typeApproval: "N1",
  wheelplan: "NON STANDARD",
  revenueWeight: 1640,
  realDrivingEmissions: "1",
  dateOfLastV5CIssued: "2016-12-25",
  euroStatus: "Euro 5",
  automatedVehicle: true,
};

/** DVSA MOT History's VehicleWithMotResponse, with the fields and enums its OpenAPI spec gives. */
export const MOT_SAMPLE = {
  registration: "AA51AAA",
  make: "Ford",
  model: "Focus",
  firstUsedDate: "2019-03-01",
  fuelType: "Petrol",
  primaryColour: "Silver",
  registrationDate: "2019-03-01",
  manufactureDate: "2019-02-11",
  engineSize: "1598",
  hasOutstandingRecall: "No",
  motTests: [
    {
      registrationAtTimeOfTest: "AA51AAA",
      completedDate: "2025-02-17T09:17:46.000Z",
      testResult: "PASSED",
      expiryDate: "2026-03-01",
      odometerValue: "41830",
      odometerUnit: "MI",
      odometerResultType: "READ",
      motTestNumber: "123456789012",
      dataSource: "DVSA",
      defects: [
        { text: "Nearside Front Tyre worn close to legal limit/worn on edge (5.2.3 (e))", type: "ADVISORY", dangerous: false },
        { text: "Front brake disc worn, pitted or scored, but not seriously weakened (1.1.14 (a) (ii))", type: "ADVISORY", dangerous: false },
        { text: "Offside Rear Registration plate lamp inoperative (4.7.1 (b) (ii))", type: "MINOR", dangerous: false },
      ],
    },
    { completedDate: "2024-02-20T10:02:00.000Z", testResult: "FAILED", expiryDate: null, odometerValue: "55000", odometerUnit: "KM", odometerResultType: "READ", motTestNumber: "123456789011", dataSource: "DVSA", defects: [{ text: "Offside Headlamp not working (4.1.1 (a) (ii))", type: "MAJOR", dangerous: false }] },
    { completedDate: "2024-02-21T10:02:00.000Z", testResult: "PASSED", expiryDate: "2025-03-01", odometerValue: null, odometerUnit: null, odometerResultType: "UNREADABLE", motTestNumber: "123456789010", dataSource: "DVSA", defects: null },
    { completedDate: "2023-02-19T11:00:00.000Z", testResult: "PASSED", expiryDate: "2024-03-01", odometerValue: "26545", odometerUnit: "MI", odometerResultType: "READ", motTestNumber: "123456789009", dataSource: "DVSA" },
  ],
};

/** DVSA's NewRegVehicleResponse: too new for an MOT. */
export const NEW_REG_SAMPLE = { registration: "AB24CDE", make: "Kia", model: "Niro", manufactureYear: "2024", fuelType: "Electric", primaryColour: "White", registrationDate: "2024-03-14", manufactureDate: "2024-01-10", motTestDueDate: "2027-03-13", hasOutstandingRecall: "Unknown" };
