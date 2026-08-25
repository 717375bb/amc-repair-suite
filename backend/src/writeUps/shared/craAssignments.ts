import { createLogger } from '../../logging/logger.js';
import { DEFAULT_VENDOR_FORM_DEFAULTS } from './vendorConfig.js';

const log = createLogger('writeup');

/**
 * CLAUDE_CODE_PROMPT (CRA/vendor grouping, 2026-08-19) — the real
 * Vendor Code -> CRA (Component Repair Analyst) assignment table, provided
 * directly by the user as `Vendor_Assignments (1).xlsx`/`.txt` (182 rows,
 * 8 distinct CRAs, confirmed via direct file read — not transcribed by
 * hand). "CRA Code" is confirmed by the user to be the real MXI Purchasing
 * Contact ID (Brayden Bury's own row, 717375, independently matches the
 * pre-existing DEFAULT_VENDOR_FORM_DEFAULTS.purchasingContact value this
 * codebase already had, which is what confirmed the mapping).
 *
 * Deliberately retains EVERY row, including vendors with no corresponding
 * entry in VENDOR_REGISTRY yet (per explicit user instruction: "retain the
 * mapping for the CRA to the vendor but only let it affect registered
 * vendors in the live version now") — resolvePurchasingContactForVendorCode
 * and listCraGroups (api/vendors.ts) are what actually narrow this down to
 * registered vendors only; this table itself is the full source of truth
 * so a future vendor onboarding doesn't require re-collecting this data.
 */
export interface CraVendorAssignment {
  vendorCode: string;
  vendorName: string;
  craCode: string;
  craName: string;
}

export const CRA_VENDOR_ASSIGNMENTS: readonly CraVendorAssignment[] = [
  { vendorCode: 'VC00769', vendorName: '8tree LLC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '0BPH5', vendorName: 'ABACO SYSTEMS', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '18560', vendorName: 'ACR ARTEX-ACR ELECTRONIC INC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00331', vendorName: 'AIRR ENGINEERING', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '0GDJ0', vendorName: 'AMETEK - OK', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '3VJA2', vendorName: 'AMETEK BINGHAMTON', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00375', vendorName: 'ASTRONICS ADVANCED ELECTRONIC SYSTEMS', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '1JSZ6', vendorName: 'AVIONICA LLC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '65120', vendorName: 'AVIONICS SPECIALIST INC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00373', vendorName: 'BOEING DISTRIBUTION INC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00374', vendorName: 'BOEING DISTRIBUTION NJ', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '714N8', vendorName: 'CONTINENTAL TESTING INC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '11851', vendorName: 'DANIELS MANUFACTURING CORPORATION', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00714', vendorName: 'EPICAMRO INC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00644', vendorName: 'EVIDENT SCIENTIFIC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '836S5', vendorName: 'GSE AMERICA LLC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00664', vendorName: 'HR SMITH GROUP', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '1YXM4', vendorName: 'JACKSON AIRCRAFT WEIGHING SERVICE', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00311', vendorName: 'MOBILE COMMUNICATION AMERICA (MCA)', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00824', vendorName: 'MSA SAFETY INCORPORATED', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '38002', vendorName: 'NAV-AIDS LTD', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00652', vendorName: 'NORTHERN OHIO EQUIPMENT SERVICE', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '1YRX6', vendorName: 'PF FISHPOLE HOISTS INC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00854', vendorName: 'REGION RENTS SALES & SERVICE', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '003T0', vendorName: 'SAFRAN ELECTRONICS & DEFENSE', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '0TMJ9', vendorName: 'SECURAPLANE TECHNOLOGIES', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'P063A', vendorName: 'SIEMENS INDUSTRIES INC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00779', vendorName: 'TECHNOLOGIES HARNESS SCANNER INC (THS)', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '67040', vendorName: 'TOOL TESTING LAB', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00186', vendorName: 'TRANSCAT INC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '3BC99', vendorName: 'UNITRON LP', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00372', vendorName: 'UNIVERSAL AVIONICS SYSTEMS CORPORATION', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '7CGG1', vendorName: 'USA BORESCOPES', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '1DBF7', vendorName: 'VALUE TOOL AND ENGINEERING', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'P033A', vendorName: 'VANDALIA MACHINING INC', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00674', vendorName: 'VIAVI SOLUTIONS', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: 'VC00116', vendorName: 'VIEWTECH BORESCOPES', craCode: '232126', craName: 'Alex Morales' },
  { vendorCode: '7WVJ2', vendorName: 'AERO HYDRAULIC INC', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: 'VC00800', vendorName: 'AIRBORNE MX & ENG SVC (AMES)', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '3TAH8', vendorName: '"COLLINS - MONROE, NC"', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '89305', vendorName: 'COLLINS - VT', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '0CAM5', vendorName: 'HAM CARE - AZ', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '75818', vendorName: 'HAM SUND - FL', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '99167', vendorName: 'HAMILTON SUNDSTRAND AEROSPACE  - IL', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '83014', vendorName: 'HARTWELL CORPORATION', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: 'VC00462', vendorName: 'HYDRO-AIRE AEROSPACE CORP', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '1NQ67', vendorName: 'INTELSAT INFLIGHT LLC', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: 'VC00730', vendorName: 'NORTHROP GRUMMAN SYSTEMS CORPORATION', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: 'VC00679', vendorName: 'PERFORM AIR INTERNATIONAL INC', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: 'VC00201', vendorName: 'REGIONAL AVIONICS REPAIR LLC', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '76863', vendorName: 'ROCKWELL - SEATTLE', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '1SMU4', vendorName: 'ROCKWELL COLLINS - ATLANTA', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '6FVE5', vendorName: 'ROCKWELL COLLINS - CALEXICO', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '4X623', vendorName: 'ROCKWELL COLLINS - WICHITA', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: '7A9Y2', vendorName: 'SKYPAXXX INTERIOR REPAIRS', craCode: '232275', craName: 'Andres Sabido' },
  { vendorCode: 'P054A', vendorName: 'AERO REPAIR - INDY', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: 'VC00412', vendorName: 'AERO REPAIR - NH', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: 'VC00794', vendorName: 'AERO REPAIR CORP - DFW', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: 'VC01183', vendorName: 'AERO REPAIR GEORGIA', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: 'VC01059', vendorName: 'ARC - ACTION RESEARCH CORPORATION', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: '68184', vendorName: 'ARKWIN INDUSTRIES INC', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: '10933', vendorName: 'AVIONIC INSTRUMENTS LLC', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: '30242', vendorName: 'AVTECHTYEE INC', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: '21844', vendorName: 'BARFIELD INSTRUMENT CORP', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: '0T1Y4', vendorName: 'BARFIELD PRECISION ELECTRONICS LLC', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: '0GZF3', vendorName: 'HEADS UP TECHNOLOGIES INC', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: '66130', vendorName: 'KULITE SEMICONDUCTOR PRODUCTS INC', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: 'VC00564', vendorName: 'LUMINATOR HOLDING LP', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: '6MXR1', vendorName: 'MEASURETECH INC', craCode: '717375', craName: 'Brayden Bury' },
  { vendorCode: 'VC01229', vendorName: 'AERSALE LANDING GEAR SOLUTIONS', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: 'VC00929', vendorName: 'AMERICAN TESTING SERVICES LTD', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: '7554', vendorName: '"CTL AEROSPACE, INC."', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: 'VC00402', vendorName: 'GA TELESIS MRO SERVICES GROUP', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: 'P058A', vendorName: 'GE ENGINE SERVICES INC', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: '5326', vendorName: 'GE ENGINE SERVICES LLC - ACSC', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: 'VC00974', vendorName: 'IHI CORPORATION', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: 'P055A', vendorName: 'IHI-ICR LLC', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: '4PX05', vendorName: 'INTERNATIONAL COMPONENT REPAIR LLC', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: 'VC01029', vendorName: '"JET AIRWERKS, LLC"', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: '1NLK7', vendorName: 'JET AVIATION SPECIALISTS', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: 'DN004', vendorName: 'LUFTHANSA AERO GMBH', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: '4GJM6', vendorName: 'PAS TECHNOLOGIES INC', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: '08XL0', vendorName: 'PROFESSIONAL AIRCRAFT ACCESSORIES', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: '67620', vendorName: 'STANDARD AERO - CINCINNATI', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: '12421', vendorName: 'STANDARD AERO ALLIANCE INC', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: 'P061A', vendorName: 'STANDARD AERO LIMITED - WINNIPEG', craCode: '972257', craName: 'Eric Sipper' },
  { vendorCode: 'VC00554', vendorName: 'A & R AVIATION SERVICES INC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '3Y015', vendorName: 'AAR AIRCRAFT COMPONENT SERVICES NY', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '5KM29', vendorName: '"AAR COMPONENT SERVICES - GP, INC."', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '26101', vendorName: 'AAR COMPONENT SERVICES - KS', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '63537', vendorName: 'AAR CORPORATION', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: 'VC00605', vendorName: 'ABOVE GROUND LEVEL AVIATION', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '65019', vendorName: 'AERO INSTRUMENTS AND AVIONICS', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '35FB9', vendorName: 'AMSAFE INC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '0LZ73', vendorName: 'AVIATION AVIONICS & INSTRUMENTS - AAIC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: 'VC00829', vendorName: '"AVIATION INFLATABLES, LLC"', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '7LKW0', vendorName: 'AVIOCRAFT', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '63367', vendorName: 'B/E AEROSPACE INC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '3CJS5', vendorName: 'FUTURE AVIATION', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: 'VC00789', vendorName: 'GENERAL MRO AEROSPACE INC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '5S077', vendorName: 'HERBER AIRCRAFT SERVICE INC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: 'VC00949', vendorName: "HONEYWELL INT'L - MEXICALI", craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: 'VC00108', vendorName: "HONEYWELL INT'L - OLATHE", craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '7X000', vendorName: "HONEYWELL INT'L - SKYHARBOR", craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '59364', vendorName: "HONEYWELL INT'L - TEMPE", craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '64547', vendorName: "HONEYWELL INT'L - TUCSON", craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '32RD2', vendorName: 'INTECH AEROSPACE LLC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '1QGN5', vendorName: '"MEDAIRE, INC"', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '6603', vendorName: 'PACIFIC SCIENTIFIC AVIATION SERVICES', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '3ECB3', vendorName: 'PHOENIX AIR REPAIR INC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '567V9', vendorName: 'SAFRAN - GA', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: 'VC00607', vendorName: 'SAFRAN AEROSYSTEMS', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '55912', vendorName: 'SAFRAN AEROSYSTEMS SERVICES AMERICAS LLC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '56135', vendorName: 'SAFRAN CABIN INC - GARDEN GROVE', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '81640', vendorName: '"SAFRAN POWER USA, LLC"', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '899J9', vendorName: 'SAFRAN SEATS USA LLC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '6GF22', vendorName: 'SAFRAN SERVICES AMERICAS', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '3TRJ7', vendorName: 'SAFRAN VENTILATION SYSTEMS USA LLC', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '29780', vendorName: 'SAFRAN WATER & WASTE', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '1D2Q0', vendorName: 'SKYTEAM INTERNATIONAL COMPANY', craCode: '285576', craName: 'Landon Eagler' },
  { vendorCode: '2N512', vendorName: 'AEROTRON AIR POWER INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00814', vendorName: 'AIRGROUP DYNAMICS INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00584', vendorName: 'AIRLINE COMPONENT PARTS LLC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '1JYM3', vendorName: 'AVIATRON INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '5YRM0', vendorName: 'CAMTRONICS LLC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00569', vendorName: 'CHAMPION AEROSPACE LLC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00870', vendorName: 'CIRCOR AEROSPACE INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '1BAY3', vendorName: 'CSI AEROSPACE INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00524', vendorName: 'DCM GROUP INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '8719', vendorName: 'DUCOMMUN TECHONOLGIES', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '2750', vendorName: 'EATON CORPORATION', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '59875', vendorName: 'EATON INDUSTRIAL CORPORATION', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00879', vendorName: 'FIRSTMARK AEROSPACE CORPORATION', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '1DH10', vendorName: 'HRD AERO SYSTEMS INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00664', vendorName: 'HR SMITH GROUP', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '58657', vendorName: 'LEACH - CA', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC01014', vendorName: 'LEADING EDGE AEROSPACE', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC01197', vendorName: 'LIEBHERR AEROSPACE - NORTH MAPLE RD', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '8S625', vendorName: 'LIEBHERR AEROSPACE SALINE INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '76227', vendorName: 'LIEBHERR-AEROSPACE LINDENBERG GMBH', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '0B9R9', vendorName: 'MEGGITT AIRCRAFT BRAKING SYSTEMS', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '0VXA1', vendorName: 'MIDWEST AERO SUPPORT LLC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '3H889', vendorName: 'PARKER AERO - CA', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '26433', vendorName: 'PARKER AERO - OH', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '99321', vendorName: 'PARKER HANNIFIN - FL', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '93835', vendorName: 'PARKER HANNIFIN - MI', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '86329', vendorName: 'PARKER HANNIFIN-NICHOLS AIRBORNE', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00445', vendorName: 'REXNORD INDUSTRIES LLC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '75521', vendorName: 'ROTRON INC.', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '16630', vendorName: 'TAT-LIMCO', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00399', vendorName: '"THALES AVIONICS, INC."', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '67107', vendorName: 'TRIUMPH CONTROLS INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '67KR8', vendorName: 'VANGUARD AEROSPACE LLC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '67365', vendorName: 'WOODWARD INC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: '19710', vendorName: 'WOODWARD MPC', craCode: '238784', craName: 'Matthew Fascenda' },
  { vendorCode: 'VC00909', vendorName: '"AK-STRUCTURES, LLC"', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: 'VC00859', vendorName: 'ALLFLIGHT CORPORATION', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: 'VC01187', vendorName: 'APAS - A PROFESSIONAL AVIATION SERVICES', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: '63760', vendorName: 'BAE SYSTEMS CONTROLS INC', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: 'VC01208', vendorName: '"GLASS AERO, INC."', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: '53117', vendorName: 'PPG INDUSTRIES INC', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: 'VC01060', vendorName: '"PREFERRED COMPOSITE SERVICES, INC"', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: 'VC01224', vendorName: 'QT Aerospace', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: '76725', vendorName: 'RATIER FIGEAC', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: 'VC00529', vendorName: 'SUMMIT AEROSPACE INC', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: 'VC00809', vendorName: 'WORTHINGTON MRO CENTER', craCode: '232134', craName: 'Monica Gonzalez' },
  { vendorCode: 'VC00984', vendorName: 'ACRON AVIATION INC', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: 'VC00241', vendorName: 'AERO COMPOSITES AND STRUCTURES INC', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: '1V2E4', vendorName: 'ATS COMPONENTS', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: '65365', vendorName: 'COMTEK ADVANCED STRUCTURES LTD', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: 'VC00401', vendorName: '"GA TELESIS COMPOSITE REPAIR GROUP, LLC"', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: 'P056A', vendorName: 'HOT SECTION TECHNOLOGIES INC', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: '48H84', vendorName: 'INNODYNE SYSTEMS LLC', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: 'VC00934', vendorName: 'KAVLICO CORPORATION', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: '61423', vendorName: 'KIDDE AEROSPACE AND DEFENSE', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: 'F0073', vendorName: 'LATECOERE', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: 'VC01107', vendorName: '"LATITUDE AERO, LLC"', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: 'VC01167', vendorName: 'MEXICO MRO MANAGEMENT', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: '4TYB3', vendorName: 'POLY-FIBER ENTERPRISES INC', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: '1MXA1', vendorName: 'RADIANT POWER CORPORATION', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: 'VC01009', vendorName: '"SAL AEROSPACE TECHNOLOGIES, INC."', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: '74063', vendorName: 'TE CONNECTIVITY CORPORATION', craCode: '248648', craName: 'Samantha Jackson' },
  { vendorCode: '1BRV8', vendorName: 'WVAC - MHI RJ AVIATION', craCode: '248648', craName: 'Samantha Jackson' },
];

const ASSIGNMENT_BY_VENDOR_CODE = new Map<string, CraVendorAssignment>(
  CRA_VENDOR_ASSIGNMENTS.map((row) => [row.vendorCode.trim().toUpperCase(), row]),
);

/**
 * Resolves a registered vendor's Purchasing Contact from the CRA
 * assignment table, by real MXI vendor code (not the codebase's internal
 * lowercased VendorConfig.id). Falls back to the pre-existing global
 * default (717375) and logs a warning if the code isn't in the table —
 * never a hard failure, since a vendor being added to VENDOR_REGISTRY
 * ahead of the CRA spreadsheet catching up is a real, survivable
 * situation, not a bug.
 */
export function resolvePurchasingContactForVendorCode(vendorCode: string): string {
  const assignment = ASSIGNMENT_BY_VENDOR_CODE.get(vendorCode.trim().toUpperCase());
  if (!assignment) {
    log.warn(
      { vendorCode },
      '[cra-assignments] vendor code has no CRA assignment row — falling back to global default purchasing contact',
    );
    return DEFAULT_VENDOR_FORM_DEFAULTS.purchasingContact;
  }
  return assignment.craCode;
}

/**
 * Aero Repair is a structurally different module (see
 * writeUps/aeroRepair/vendorConfig.ts) — it searches by a fixed
 * OEM part-number list, not a single real MXI vendor code, so it has no
 * one-to-one entry in CRA_VENDOR_ASSIGNMENTS the way every other vendor
 * does. All 4 real Aero Repair vendor codes in the assignment table
 * (P054A, VC00412, VC00794, VC01183) resolve to the same CRA (Brayden
 * Bury, 717375) — confirmed directly, not assumed — so this constant is
 * safe to use as Aero Repair's single CRA for grouping purposes, even
 * though there's no vendor-code lookup to derive it from at request time.
 */
export const AERO_REPAIR_CRA_CODE = '717375';

export interface CraGroup {
  craCode: string;
  craName: string;
  /** All vendor codes assigned to this CRA per the source table, registered or not. */
  vendorCodes: string[];
}

/** Groups the full assignment table by CRA — every vendor, registered or not. Consumed by api/vendors.ts to narrow down to registered/known vendors only. */
export function listCraGroups(): CraGroup[] {
  const byCode = new Map<string, CraGroup>();
  for (const row of CRA_VENDOR_ASSIGNMENTS) {
    let group = byCode.get(row.craCode);
    if (!group) {
      group = { craCode: row.craCode, craName: row.craName, vendorCodes: [] };
      byCode.set(row.craCode, group);
    }
    group.vendorCodes.push(row.vendorCode);
  }
  return [...byCode.values()].sort((a, b) => a.craName.localeCompare(b.craName));
}
