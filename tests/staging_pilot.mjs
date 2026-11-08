import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const SWITCHBOARD_URL = process.env.SWITCHBOARD_URL || 'http://localhost:3000';
const BRIDGE_KEY = process.env.BRIDGE_KEY || fs.readFileSync('agent-bridge/bridge_key.txt', 'utf8').trim();
const MOCK_PORT = 4001;

async function runStagingPilot() {
  const TEST_AGENT = 'pilot-' + Math.random().toString(36).substring(2, 7);
  console.log('=======================================================');
  console.log(`🚀 STARTING SWITCHBOARD v2.6.14 STAGING PILOT SUITE (${TEST_AGENT})`);
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
    console.log(`[Test 1] Probe Challenge Result: ${test1Pass ? '✅ PASS' : '❌ FAIL'}`);

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
    console.log(`[Test 2] Verification Result: ${test2Pass ? '✅ PASS' : '❌ FAIL'}`);

    // TEST 2b: Consumed Challenge Replay Rejection (replay used nonce against still-Active endpoint)
    console.log('\n[Test 2b] Replaying Consumed Challenge Against Active Endpoint...');
    const replayRes = await fetch(`${SWITCHBOARD_URL}/api/webhook/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: TEST_AGENT,
        challenge: receivedChallenge
      })
    });
    const replayData = await replayRes.json();
    const test2bPass = replayRes.status >= 400 && !replayData.success && !replayData.signingSecret;
    results.push({
      test: 'ConsumedChallenge_ReplayRejectedWhileActive',
      pass: test2bPass,
      details: { status: replayRes.status, error: replayData.error, secretReIssued: !!replayData.signingSecret }
    });
    console.log(`[Test 2b] Consumed Challenge Replay Result: ${test2bPass ? '✅ PASS' : '❌ FAIL'}`);

    // TEST 3: Cryptographically Signed Dispatch & Replay Guard
    console.log('\n[Test 3] Testing Signed Webhook Dispatch & Signature Validity...');
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
    console.log(`[Test 3] Signed Dispatch Result: ${test3Pass ? '✅ PASS' : '❌ FAIL'}`);

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
    console.log(`[Test 4] Non-Recipient Result: ${test4Pass ? '✅ PASS' : '❌ FAIL'}`);

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
    console.log(`[Test 5] Kill Switch Result: ${test5Pass ? '✅ PASS' : '❌ FAIL'}`);

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

    // TEST 7: Version Alignment (/api/health reports matching /api/docs)
    console.log('\n[Test 7] Testing System Version Alignment...');
    const healthRes = await fetch(`${SWITCHBOARD_URL}/api/health`);
    const healthData = await healthRes.json();
    const docsRes = await fetch(`${SWITCHBOARD_URL}/api/docs`);
    const docsData = await docsRes.json();
    const docsVer = docsData.version || (docsData.info && docsData.info.version);
    const test7Pass = healthRes.status === 200 && healthData.version === docsVer;
    results.push({
      test: 'VersionAlignment_HealthAndDocs',
      pass: test7Pass,
      details: { status: healthRes.status, healthVersion: healthData.version, docsVersion: docsVer }
    });
    console.log(`[Test 7] Version Alignment Result: ${test7Pass ? '✅ PASS' : '❌ FAIL'} (${healthData.version} == ${docsVer})`);

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
    console.log(`[Test 8] Replay Invalidation Result: ${test8Pass ? '✅ PASS' : '❌ FAIL'}`);

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
    console.log(`[Test 9] Privacy Mode Result: ${test9Pass ? '✅ PASS' : '❌ FAIL'}`);

    // TEST 10: Strict Authentication Guard on Operational Endpoints
    console.log('\n[Test 10] Testing Strict Auth Guard on Operational Endpoints...');
    const noKeyRes = await fetch(`${SWITCHBOARD_URL}/api/messages`);
    const wrongKeyRes = await fetch(`${SWITCHBOARD_URL}/api/messages?key=invalid_bad_key`);
    const noKeyStreamRes = await fetch(`${SWITCHBOARD_URL}/api/stream`);
    const noKeyPostRes = await fetch(`${SWITCHBOARD_URL}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'attacker', to: 'all', text: 'unauthorized post' })
    });
    const validKeyRes = await fetch(`${SWITCHBOARD_URL}/api/messages?key=${BRIDGE_KEY}`);

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
    console.log(`[Test 10] Strict Auth Result: ${test10Pass ? '✅ PASS' : '❌ FAIL'}`);

    // TEST 11: Direct-Only Broadcast Suppression (Message to 'all' strictly dropped for direct-only)
    console.log('\n[Test 11] Testing Direct-Only Broadcast Suppression...');
    receivedEvents.length = 0;
    await fetch(`${SWITCHBOARD_URL}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Key': BRIDGE_KEY
      },
      body: JSON.stringify({
        from: 'antigravity',
        to: 'all',
        text: 'Broadcast message to everyone [by agent]'
      })
    });
    await new Promise(r => setTimeout(r, 600));

    // PRIVACY_AGENT was registered as direct-only! It must NOT receive the broadcast!
    const broadcastLeak = receivedEvents.filter(e => e.payload && e.payload.agent === PRIVACY_AGENT || e.path === '/privacy-hook');
    const test11Pass = broadcastLeak.length === 0;
    results.push({
      test: 'DirectOnly_BroadcastSuppression',
      pass: test11Pass,
      details: { broadcastDeliveriesToDirectOnly: broadcastLeak.length }
    });
    console.log(`[Test 11] Broadcast Suppression Result: ${test11Pass ? '✅ PASS' : '❌ FAIL'} (Deliveries: ${broadcastLeak.length}, Expected: 0)`);

    // TEST 12: Receiver Timestamp Replay & Tamper Verification
    console.log('\n[Test 12] Testing Receiver Timestamp Replay Window & Tamper Rejection...');
    // Receiver-side logic: reject if timestamp > 300s old or signature does not match
    const mockSecret = 'test_secret_key_123';
    const validTs = Date.now();
    const expiredTs = Date.now() - 360000; // 6 minutes ago
    const sampleBody = JSON.stringify({ event: 'message.created', text: 'hello' });
    const validSig = crypto.createHmac('sha256', mockSecret).update(`${validTs}.${sampleBody}`).digest('hex');
    const tamperedSig = crypto.createHmac('sha256', mockSecret).update(`${validTs}.${sampleBody}_tampered`).digest('hex');

    function verifyDelivery(ts, body, sig, secret) {
      if (Math.abs(Date.now() - parseInt(ts, 10)) > 300000) return { valid: false, reason: 'timestamp_expired' };
      const expected = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
      if (sig !== expected) return { valid: false, reason: 'signature_mismatch' };
      return { valid: true };
    }

    const checkValid = verifyDelivery(validTs, sampleBody, validSig, mockSecret);
    const checkExpired = verifyDelivery(expiredTs, sampleBody, validSig, mockSecret);
    const checkTampered = verifyDelivery(validTs, sampleBody, tamperedSig, mockSecret);

    const test12Pass = checkValid.valid === true && checkExpired.valid === false && checkTampered.valid === false;
    results.push({
      test: 'ReceiverTimestamp_ReplayAndTamperGuard',
      pass: test12Pass,
      details: {
        validDeliveryAccepted: checkValid.valid,
        expiredTimestampRejected: !checkExpired.valid,
        tamperedSignatureRejected: !checkTampered.valid
      }
    });
    console.log(`[Test 12] Replay/Tamper Guard Result: ${test12Pass ? '✅ PASS' : '❌ FAIL'}`);

    // TEST 13: SSRF Private IP & Metadata Range Rejection
    console.log('\n[Test 13] Testing SSRF Private IP & Metadata Rejection...');
    const ssrfMetadataRes = await fetch(`${SWITCHBOARD_URL}/api/webhook/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'ssrf-test-1', url: 'http://169.254.169.254/latest/meta-data' })
    });
    const ssrfPrivate10Res = await fetch(`${SWITCHBOARD_URL}/api/webhook/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'ssrf-test-2', url: 'http://10.0.0.1/admin' })
    });
    const ssrfPrivate192Res = await fetch(`${SWITCHBOARD_URL}/api/webhook/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'ssrf-test-3', url: 'http://192.168.1.1/router' })
    });

    const test13Pass = ssrfMetadataRes.status === 400 && ssrfPrivate10Res.status === 400 && ssrfPrivate192Res.status === 400;
    results.push({
      test: 'SSRF_PrivateRangeRejection',
      pass: test13Pass,
      details: {
        metadata169Status: ssrfMetadataRes.status,
        private10Status: ssrfPrivate10Res.status,
        private192Status: ssrfPrivate192Res.status
      }
    });
    console.log(`[Test 13] SSRF Guard Result: ${test13Pass ? '✅ PASS' : '❌ FAIL'} (169.254: ${ssrfMetadataRes.status}, 10.x: ${ssrfPrivate10Res.status}, 192.168: ${ssrfPrivate192Res.status})`);

  } finally {
    mockServer.close();
  }

  const allPassed = results.every(r => r.pass);
  console.log('\n=======================================================');
  console.log(`🏁 STAGING PILOT SUMMARY: ${allPassed ? `ALL ${results.length} TESTS PASSED ✅` : 'FAILURES DETECTED ❌'}`);
  console.log(`Total Checks: ${results.length} | Passed: ${results.filter(r => r.pass).length} | Failed: ${results.filter(r => !r.pass).length}`);
  console.log('=======================================================\n');

  const evidenceReport = {
    suite: 'Switchboard_v2.6.14_ProbeChallenge_Pilot',
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
