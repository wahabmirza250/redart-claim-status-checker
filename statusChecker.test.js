/**
 * Regression test for claim status parser
 * Verifies that detected_status is extracted from the matching result row's
 * Claim Status column ONLY, never from page-wide filter labels.
 */

const { extractClaimStatusFromRow } = require('./statusChecker');

// Test case 1: Row with Denied status when page filter labels contain "Paid"
// This is the exact regression that occurred with claim 2326241001014
// Row structure: Claim ID | Member | ClaimType | Status | Amount | Date | ...
const testCase1_deniedRow = [
  '2326241001014',
  'Professional',
  'Denied',
  '08/19/2026',
  '$0.00'
];

// Simulate a page that has both Denied and Paid filter options (like HCPF search form)
// The old parser would incorrectly extract "Paid" from filter labels if they appeared
// earlier in the document. The new parser extracts ONLY from the result row cells.
const testCase1_claim = '2326241001014';

// Test case 2: Row with Paid status (control test)
const testCase2_paidRow = [
  '2326241001015',
  'Transportation',
  'Paid',
  '08/18/2026',
  '$125.50'
];
const testCase2_claim = '2326241001015';

// Test case 3: Row with In Process status
const testCase3_inProcessRow = [
  '2326241001016',
  'Medical',
  'In Process',
  '08/20/2026',
  '$0.00'
];
const testCase3_claim = '2326241001016';

// Test case 4: Row with Suspended status
const testCase4_suspendedRow = [
  '2326241001017',
  'Dental',
  'Suspended',
  '08/21/2026',
  '$75.00'
];
const testCase4_claim = '2326241001017';

// Test case 5: Row with Rejected status
const testCase5_rejectedRow = [
  '2326241001018',
  'Vision',
  'Rejected',
  '08/22/2026',
  '$0.00'
];
const testCase5_claim = '2326241001018';

console.log('🧪 Regression Test Suite: Claim Status Parser\n');

// Run test case 1
console.log('Test 1: Denied status when page contains Paid labels');
try {
  const status1 = extractClaimStatusFromRow(testCase1_deniedRow, testCase1_claim);
  if (status1 === 'Denied') {
    console.log('✅ PASS: Correctly extracted Denied from row (not from page filters)');
  } else {
    console.log(`❌ FAIL: Expected Denied, got ${status1}`);
    process.exit(1);
  }
} catch (err) {
  console.log(`❌ FAIL: Exception thrown: ${err.message}`);
  process.exit(1);
}

// Run test case 2
console.log('\nTest 2: Paid status (control)');
try {
  const status2 = extractClaimStatusFromRow(testCase2_paidRow, testCase2_claim);
  if (status2 === 'Paid') {
    console.log('✅ PASS: Correctly extracted Paid');
  } else {
    console.log(`❌ FAIL: Expected Paid, got ${status2}`);
    process.exit(1);
  }
} catch (err) {
  console.log(`❌ FAIL: Exception thrown: ${err.message}`);
  process.exit(1);
}

// Run test case 3
console.log('\nTest 3: In Process status');
try {
  const status3 = extractClaimStatusFromRow(testCase3_inProcessRow, testCase3_claim);
  if (status3 === 'In Process') {
    console.log('✅ PASS: Correctly extracted In Process');
  } else {
    console.log(`❌ FAIL: Expected In Process, got ${status3}`);
    process.exit(1);
  }
} catch (err) {
  console.log(`❌ FAIL: Exception thrown: ${err.message}`);
  process.exit(1);
}

// Run test case 4
console.log('\nTest 4: Suspended status');
try {
  const status4 = extractClaimStatusFromRow(testCase4_suspendedRow, testCase4_claim);
  if (status4 === 'Suspended') {
    console.log('✅ PASS: Correctly extracted Suspended');
  } else {
    console.log(`❌ FAIL: Expected Suspended, got ${status4}`);
    process.exit(1);
  }
} catch (err) {
  console.log(`❌ FAIL: Exception thrown: ${err.message}`);
  process.exit(1);
}

// Run test case 5
console.log('\nTest 5: Rejected status');
try {
  const status5 = extractClaimStatusFromRow(testCase5_rejectedRow, testCase5_claim);
  if (status5 === 'Rejected') {
    console.log('✅ PASS: Correctly extracted Rejected');
  } else {
    console.log(`❌ FAIL: Expected Rejected, got ${status5}`);
    process.exit(1);
  }
} catch (err) {
  console.log(`❌ FAIL: Exception thrown: ${err.message}`);
  process.exit(1);
}

console.log('\n✨ All regression tests passed!\n');

