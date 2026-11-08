import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const SWITCHBOARD_URL = process.env.SWITCHBOARD_URL || 'http://localhost:3000';
const BRIDGE_KEY = process.env.BRIDGE_KEY || 'bry_f704515bcae1aa2ef9d1a240c33468d3';
const MOCK_PORT = 4001;

async function runStagingPilot() {
  const TEST_AGENT = 'pilot-' + Math.random().toString(36).substring(2, 7);
  console.log('=======================================================');
  console.log(`🚀 STARTING SWITCHBOARD v2.6.11 STAGING PILOT SUITE (${TEST_AGENT})`);
  console.log(`Target Switchboard: ${SWITCHBOARD_URL}`);
  console.log('=======================================================\n');

  const receivedEvents = [];

  // 1. Synthetic destination mock server to capture outbound probes and dispatches
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        receivedEvents.push({
          time: Date.now(),
          path: req.url,
          headers: req.headers,
          rawBody: body,
          payload
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', received: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  });

  await new Promise(resolve => mockServer.listen(MOCK_PORT, resolve));
  console.log(`[Staging] Mock destination server listening on port ${MOCK_PORT}`);

  const results = [];

  try {
    // TEST 1: Outbound Probe Challenge on Registration (Zero Nonce in Response)
    console.log('\n[Test 1] Testing Outbound Probe Challenge on Registration...');
    receivedEvents.length = 0;

    const regRes = await fetch(`${SWITCHBOARD_URL}/api/webhook/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: TEST_AGENT,
        url: `http://localhost:${MOCK_PORT}/webhook`
      })
    });
    const regData = await regRes.json();
    await new Promise(r => setTimeout(r, 400)); // wait for async probe delivery

    const probeEvent = receivedEvents.find(e => e.payload && e.payload.event === 'verification.challenge');
    const test1Pass = regData.success &&
      regData.status === 'Pending' &&
      regData.probeDispatched === true &&
      !regData.challenge && // Nonce is NOT leaked in HTTP response!
      !!probeEvent &&
      probeEvent.payload.agent === TEST_AGENT &&
      !!probeEvent.payload.challenge &&
      !probeEvent.payload.signingSecret; // Probe is strictly nonce-only (zero secret leak in probe history!)

    results.push({
      test: 'OutboundProbeChallenge_NonceOnly_NoSecretLeak',
      pass: test1Pass,
      details: {
        registrationStatus: regData.status,
        nonceLeakedInResponse: !!regData.challenge,
        probeReceivedAtEndpoint: !!probeEvent,
        probeHasNoSecret: !probeEvent?.payload?.signingSecret,
        challengeProvidedInProbe: !!probeEvent?.payload?.challenge
      }
    });
    console.log(`[Test 1] Probe Challenge Result: ${test1Pass ? '✅ PASS' : '❌ FAIL'} (Probe delivered: ${!!probeEvent}, Nonce-only: ${!probeEvent?.payload?.signingSecret})`);

    const receivedChallenge = probeEvent?.payload?.challenge;

    // TEST 2: Echo Challenge Verification -> Active State & Handover of Signing Secret
    console.log('\n[Test 2] Testing Ownership Challenge Verification with Received Nonce...');
    const verRes = await fetch(`${SWITCHBOARD_URL}/api/webhook/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: TEST_AGENT,
        challenge: receivedChallenge
      })
    });
    const verData = await verRes.json();
    const receivedSecret = verData.signingSecret;
    const test2Pass = verData.success && verData.status === 'Active' && verData.revision === 1 && !!receivedSecret;
    results.push({
      test: 'OwnershipVerification_ActiveState_SecretHandover',
      pass: test2Pass,
      details: { status: verData.status, revision: verData.revision, secretIssuedOnActivation: !!receivedSecret }
    });
    console.log(`[Test 2] Verification Result: ${test2Pass ? '✅ PASS' : '❌ FAIL'} (Status: ${verData.status}, Secret Issued: ${!!receivedSecret})`);

    // TEST 3: Cryptographically Signed Dispatch & Replay Guard
    console.log('\n[Test 3] Testing Signed Webhook Dispatch & Replay Timestamp...');
    receivedEvents.length = 0;
    await fetch(`${SWITCHBOARD_URL}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Key': BRIDGE_KEY
      },
      body: JSON.stringify({
        from: 'antigravity',
        to: TEST_AGENT,
        text: 'Synthetic signed dispatch test [by agent]'
      })
    });
    await new Promise(r => setTimeout(r, 600));

    const dispatchEvent = receivedEvents.find(e => e.payload && e.payload.event === 'message.created');
    let sigValid = false;
    if (dispatchEvent && receivedSecret) {
      const ts = dispatchEvent.headers['x-switchboard-timestamp'];
      const rawSig = dispatchEvent.headers['x-switchboard-signature'] || '';
      const sigHash = rawSig.replace(/^v1=/, '');
      const expected = crypto.createHmac('sha256', receivedSecret).update(`${ts}.${dispatchEvent.rawBody}`).digest('hex');
      sigValid = (sigHash === expected);
    }

    const test3Pass = !!dispatchEvent &&
      dispatchEvent.payload.recipient === TEST_AGENT &&
      !!dispatchEvent.headers['x-switchboard-timestamp'] &&
      sigValid;

    results.push({
      test: 'CryptographicSignatureAndReplayGuard',
      pass: test3Pass,
      details: {
        received: !!dispatchEvent,
        hasTimestamp: !!dispatchEvent?.headers['x-switchboard-timestamp'],
        signatureValid: sigValid
      }
    });
    console.log(`[Test 3] Signed Dispatch Result: ${test3Pass ? '✅ PASS' : '❌ FAIL'} (Signature Valid: ${sigValid})`);

    // TEST 4: Direct-Message Routing Isolation (Zero Leak to Non-Recipients)
    console.log('\n[Test 4] Testing Routing Isolation to Non-Recipients...');
    receivedEvents.length = 0;
    const isolateMsgId = 'iso_' + Date.now();
    await fetch(`${SWITCHBOARD_URL}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Key': BRIDGE_KEY
      },
      body: JSON.stringify({
        from: 'antigravity',
        to: 'unrelated-bot',
        text: `Strictly isolated message ${isolateMsgId} [by agent]`
      })
    });
    await new Promise(r => setTimeout(r, 600));
    const leakedToMock = receivedEvents.filter(e => e.payload && e.payload.recipient === 'unrelated-bot');
    const test4Pass = leakedToMock.length === 0;
    results.push({
      test: 'RoutingIsolation_ZeroLeakToNonRecipient',
      pass: test4Pass,
      details: { leakedCount: leakedToMock.length }
    });
    console.log(`[Test 4] Non-Recipient Result: ${test4Pass ? '✅ PASS' : '❌ FAIL'} (Leaked: ${leakedToMock.length}, Expected: 0)`);

    // TEST 5: One-Step Kill Switch & Revision Bumping
    console.log('\n[Test 5] Testing One-Step Kill Switch & Revision Increment...');
    const disRes = await fetch(`${SWITCHBOARD_URL}/api/webhook/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: TEST_AGENT })
    });
    const disData = await disRes.json();
    const disRevPass = disData.success && disData.status === 'Disabled' && disData.revision === 2;

    receivedEvents.length = 0;
    await fetch(`${SWITCHBOARD_URL}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Key': BRIDGE_KEY
      },
      body: JSON.stringify({
        from: 'antigravity',
        to: TEST_AGENT,
        text: 'Post-disable abort test [by agent]'
      })
    });
    await new Promise(r => setTimeout(r, 600));
    const test5Pass = disRevPass && receivedEvents.length === 0;
    results.push({
      test: 'KillSwitch_AtomicPreDispatchAbort',
      pass: test5Pass,
      details: { status: disData.status, revision: disData.revision, receivedAfterDisable: receivedEvents.length }
    });
    console.log(`[Test 5] Kill Switch Result: ${test5Pass ? '✅ PASS' : '❌ FAIL'} (Status: ${disData.status}, Rev: ${disData.revision}, Deliveries: ${receivedEvents.length})`);

    // TEST 6: Public Endpoint Sanitization (Zero Secret Exposure)
    console.log('\n[Test 6] Testing Public Audit Sanitization...');
    const listRes = await fetch(`${SWITCHBOARD_URL}/api/webhooks`, {
      headers: { 'X-Bridge-Key': BRIDGE_KEY }
    });
    const listData = await listRes.json();
    const botEntry = listData.webhooks.find(w => w.agent === TEST_AGENT);
    const test6Pass = botEntry && !botEntry.url && !botEntry.challenge && !botEntry.signingSecret && !botEntry.authHeader;
    results.push({
      test: 'SecurityAudit_ZeroSecretInPublicApi',
      pass: test6Pass,
      details: { entryFound: !!botEntry, urlExposed: !!botEntry?.url, secretExposed: !!botEntry?.signingSecret }
    });
    console.log(`[Test 6] Sanitized Auditing Result: ${test6Pass ? '✅ PASS' : '❌ FAIL'}`);

    // TEST 7: Version Alignment (/api/health reports 2.6.11 matching /api/docs)
    console.log('\n[Test 7] Testing System Version Alignment (/api/health == 2.6.11)...');
    const healthRes = await fetch(`${SWITCHBOARD_URL}/api/health`);
    const healthData = await healthRes.json();
    const test7Pass = healthRes.status === 200 && healthData.version === '2.6.11';
    results.push({
      test: 'VersionAlignment_HealthAndDocs',
      pass: test7Pass,
      details: { status: healthRes.status, version: healthData.version }
    });
    console.log(`[Test 7] Version Alignment Result: ${test7Pass ? '✅ PASS' : '❌ FAIL'} (Version: ${healthData.version})`);

    // TEST 8: Challenge Invalidation on Disable (Stale Challenge Replay Rejection)
    console.log('\n[Test 8] Testing Stale Challenge Replay Rejection on Disabled Endpoint...');
    const staleVerifyRes = await fetch(`${SWITCHBOARD_URL}/api/webhook/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: TEST_AGENT,
        challenge: receivedChallenge
      })
    });
    const staleVerifyData = await staleVerifyRes.json();
    const test8Pass = staleVerifyRes.status >= 400 && !staleVerifyData.success;
    results.push({
      test: 'ChallengeInvalidation_PreventsReactivation',
      pass: test8Pass,
      details: { status: staleVerifyRes.status, error: staleVerifyData.error }
    });
    console.log(`[Test 8] Replay Invalidation Result: ${test8Pass ? '✅ PASS' : '❌ FAIL'} (Status: ${staleVerifyRes.status})`);

    // TEST 9: Metadata-Only Payload Privacy Mode (Cue Run Preview Protection)
    console.log('\n[Test 9] Testing Metadata-Only Privacy Mode (Zero Message Body in Webhook)...');
    const PRIVACY_AGENT = 'privacy-' + Math.random().toString(36).substring(2, 7);
    receivedEvents.length = 0;

    const privRegRes = await fetch(`${SWITCHBOARD_URL}/api/webhook/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: PRIVACY_AGENT,
        url: `http://localhost:${MOCK_PORT}/privacy-hook`,
        scope: 'direct-only',
        payloadMode: 'metadata-only'
      })
    });
    const privRegData = await privRegRes.json();
    await new Promise(r => setTimeout(r, 400));

    const privProbeEvent = receivedEvents.find(e => e.payload && e.payload.agent === PRIVACY_AGENT);
    const privChallenge = privProbeEvent?.payload?.challenge;

    await fetch(`${SWITCHBOARD_URL}/api/webhook/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: PRIVACY_AGENT,
        challenge: privChallenge
      })
    });

    receivedEvents.length = 0;
    const sensitiveMsg = 'CONFIDENTIAL_PAYLOAD_CONTENT_' + Date.now();
    await fetch(`${SWITCHBOARD_URL}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Key': BRIDGE_KEY
      },
      body: JSON.stringify({
        from: 'antigravity',
        to: PRIVACY_AGENT,
        text: sensitiveMsg
      })
    });
    await new Promise(r => setTimeout(r, 600));

    const privDispatchEvent = receivedEvents.find(e => e.payload && e.payload.recipient === PRIVACY_AGENT);
    const hasText = privDispatchEvent?.payload && Object.prototype.hasOwnProperty.call(privDispatchEvent.payload, 'text');
    const test9Pass = !!privDispatchEvent &&
      privDispatchEvent.payload.recipient === PRIVACY_AGENT &&
      privDispatchEvent.payload.payloadMode === 'metadata-only' &&
      !hasText;

    results.push({
      test: 'MetadataOnly_PayloadPrivacy_ZeroBodyLeak',
      pass: test9Pass,
      details: {
        received: !!privDispatchEvent,
        mode: privDispatchEvent?.payload?.payloadMode,
        textOmitted: !hasText
      }
    });
    console.log(`[Test 9] Privacy Mode Result: ${test9Pass ? '✅ PASS' : '❌ FAIL'} (Text Omitted: ${!hasText}, Mode: ${privDispatchEvent?.payload?.payloadMode})`);

    // TEST 10: Strict Authentication Guard on Operational Endpoints (Zero Loopback/Tunnel Bypass)
    console.log('\n[Test 10] Testing Strict Auth Guard on Operational Endpoints (Rejecting Missing/Wrong Key)...');
    const noKeyRes = await fetch(`${SWITCHBOARD_URL}/api/messages`);
    const wrongKeyRes = await fetch(`${SWITCHBOARD_URL}/api/messages?key=invalid_bad_key`);
    const noKeyStreamRes = await fetch(`${SWITCHBOARD_URL}/api/stream`);
    const noKeyPostRes = await fetch(`${SWITCHBOARD_URL}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'attacker', to: 'all', text: 'unauthorized post' })
    });
    const validKeyRes = await fetch(`${SWITCHBOARD_URL}/api/messages?key=bry_f704515bcae1aa2ef9d1a240c33468d3`);

    const test10Pass = 
      noKeyRes.status === 401 &&
      wrongKeyRes.status === 401 &&
      noKeyStreamRes.status === 401 &&
      noKeyPostRes.status === 401 &&
      validKeyRes.status === 200;

    results.push({
      test: 'StrictAuthGuard_ZeroLoopbackBypass',
      pass: test10Pass,
      details: {
        noKeyStatus: noKeyRes.status,
        wrongKeyStatus: wrongKeyRes.status,
        noKeyStreamStatus: noKeyStreamRes.status,
        noKeyPostStatus: noKeyPostRes.status,
        validKeyStatus: validKeyRes.status
      }
    });
    console.log(`[Test 10] Strict Auth Result: ${test10Pass ? '✅ PASS' : '❌ FAIL'} (No-Key: ${noKeyRes.status}, Wrong-Key: ${wrongKeyRes.status}, Valid: ${validKeyRes.status})`);

  } finally {
    mockServer.close();
  }

  const allPassed = results.every(r => r.pass);
  console.log('\n=======================================================');
  console.log(`🏁 STAGING PILOT SUMMARY: ${allPassed ? `ALL ${results.length} TESTS PASSED ✅` : 'FAILURES DETECTED ❌'}`);
  console.log(`Total Checks: ${results.length} | Passed: ${results.filter(r => r.pass).length} | Failed: ${results.filter(r => !r.pass).length}`);
  console.log('=======================================================\n');

  const evidenceReport = {
    suite: 'Switchboard_v2.6.11_ProbeChallenge_Pilot',
    timestamp: new Date().toISOString(),
    targetUrl: SWITCHBOARD_URL,
    allPassed,
    totalTests: results.length,
    results
  };

  fs.writeFileSync('agent-bridge/tests/staging_evidence.json', JSON.stringify(evidenceReport, null, 2), 'utf-8');
  console.log('Sanitized evidence report written to agent-bridge/tests/staging_evidence.json');
}

runStagingPilot().catch(console.error);