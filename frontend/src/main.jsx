import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";
import "./styles.css";

const NAV = [
  { id: "overview", label: "Overview", icon: "grid", section: "Workspace" },
  { id: "endpoints", label: "Endpoints", icon: "plug" },
  { id: "events", label: "Event explorer", icon: "layers" },
  { id: "failure", label: "Failure lab", icon: "flask" },
  { id: "store", label: "MiniStore", icon: "bag", section: "Demo apps" },
  { id: "inbox", label: "Receiver inbox", icon: "inbox" },
  { id: "quickstart", label: "API quickstart", icon: "code", section: "Developers" }
];

const defaultPayload = {
  event: "invoice.paid",
  invoice: { id: "inv_01HT9K", amountCents: 12900, currency: "INR" },
  customer: { id: "cus_2048", email: "alex@example.com" }
};

function App() {
  const [page, setPage] = useState(() => location.hash.slice(1) || "overview");
  const [summary, setSummary] = useState(null);
  const [endpoints, setEndpoints] = useState([]);
  const [events, setEvents] = useState([]);
  const [analytics, setAnalytics] = useState([]);
  const [inbox, setInbox] = useState([]);
  const [orders, setOrders] = useState([]);
  const [quickstart, setQuickstart] = useState(null);
  const [selectedEventId, setSelectedEventId] = useState("");
  const [message, setMessage] = useState(null);
  const [serviceHealth, setServiceHealth] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const requests = await Promise.allSettled([
      api("/api/summary"), api("/api/endpoints"), api("/api/events"),
      api("/api/analytics/endpoints"), api("/api/receiver/inbox"),
      api("/api/store/orders"), api("/api/quickstart"), api("/api/health")
    ]);
    const [summaryResult, endpointsResult, eventsResult, analyticsResult, inboxResult, ordersResult, quickstartResult, healthResult] = requests;
    if (summaryResult.status === "fulfilled") setSummary(summaryResult.value);
    if (endpointsResult.status === "fulfilled") setEndpoints(endpointsResult.value.endpoints);
    if (eventsResult.status === "fulfilled") setEvents(eventsResult.value.events);
    if (analyticsResult.status === "fulfilled") setAnalytics(analyticsResult.value.endpoints);
    if (inboxResult.status === "fulfilled") setInbox(inboxResult.value.receipts);
    if (ordersResult.status === "fulfilled") setOrders(ordersResult.value.orders);
    if (quickstartResult.status === "fulfilled") setQuickstart(quickstartResult.value);
    if (healthResult.status === "fulfilled") setServiceHealth(healthResult.value.services);
    if (requests.some((result) => result.status === "rejected")) {
      setMessage({ kind: "error", text: "HookGuard could not reach every service. Check the API, worker, Postgres and Redis processes." });
    } else {
      setMessage((current) => current?.persistent ? current : null);
    }
    setLastSync(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    const onHashChange = () => setPage(location.hash.slice(1) || "overview");
    window.addEventListener("hashchange", onHashChange);
    const timer = window.setInterval(refresh, 1800);
    void refresh();
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (events.length && !events.some((event) => event.id === selectedEventId)) setSelectedEventId(events[0].id);
    if (!events.length) setSelectedEventId("");
  }, [events, selectedEventId]);

  const selectedEvent = useMemo(() => events.find((event) => event.id === selectedEventId) || null, [events, selectedEventId]);
  const activeNav = NAV.find((item) => item.id === page) || NAV[0];

  async function runAction(action, successText, nextPage) {
    try {
      const result = await action();
      if (nextPage) navigate(nextPage);
      await refresh();
      setMessage({ kind: "success", text: successText });
      return result;
    } catch (error) {
      setMessage({ kind: "error", text: error.message, persistent: true });
      throw error;
    }
  }

  function navigate(destination) {
    if (destination === page) return;
    location.hash = destination;
  }

  return (
    <div className="appFrame">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={() => navigate("overview")}>
          <span className="brandMark"><Icon name="hook" /></span>
          <span><strong>hookguard</strong><small>delivery control plane</small></span>
        </a>

        <div className="workspaceSwitch">
          <span className="workspaceAvatar">S</span>
          <span className="workspaceCopy"><strong>Sandbox workspace</strong><small>Local development</small></span>
          <Icon name="chevron" />
        </div>

        <nav className="sideNav" aria-label="Main navigation">
          {NAV.map((item) => (
            <React.Fragment key={item.id}>
              {item.section && <div className="navSection">{item.section}</div>}
              <a className={`navItem ${page === item.id ? "selected" : ""}`} href={`#${item.id}`} onClick={() => navigate(item.id)}>
                <Icon name={item.icon} /><span>{item.label}</span>
                {item.id === "events" && summary?.counts?.failed > 0 && <b className="navBadge">{summary.counts.failed}</b>}
                {item.id === "inbox" && inbox.length > 0 && <b className="navBadge quiet">{inbox.length}</b>}
              </a>
            </React.Fragment>
          ))}
        </nav>

        <div className="sidebarBottom">
          <div className="pipelineCard">
            <div className="pipelineCardHead"><span className="pulseDot" /> Pipeline status</div>
            <ServiceRow label="API" status={serviceHealth?.api} />
            <ServiceRow label="Worker" status={serviceHealth?.worker} />
            <ServiceRow label="Postgres" status={serviceHealth?.postgres} />
            <ServiceRow label="Redis" status={serviceHealth?.redis} />
          </div>
          <div className="sidebarFoot"><span>HOOKGUARD / LOCAL</span><span>v1.0.0</span></div>
        </div>
      </aside>

      <div className="mainColumn">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><Icon name="chevron" /><strong>{activeNav.label}</strong></div>
          <div className="topbarActions">
            <span className="liveTag"><span className="pulseDot" /> Live updates</span>
            <button className="iconButton" type="button" title="Refresh data" onClick={() => void refresh()}><Icon name="refresh" /></button>
            <span className="avatar" title="Local operator">LC</span>
          </div>
        </header>

        <main className="pageContent">
          {message && <div className={`toast ${message.kind}`} role="status"><Icon name={message.kind === "error" ? "warning" : "check"} /><span>{message.text}</span><button aria-label="Dismiss" onClick={() => setMessage(null)}>×</button></div>}
          {page === "overview" && <Overview summary={summary} events={events} analytics={analytics} serviceHealth={serviceHealth} loading={loading} lastSync={lastSync} onNavigate={navigate} onSelectEvent={(id) => { setSelectedEventId(id); navigate("events"); }} />}
          {page === "endpoints" && <EndpointsPage endpoints={endpoints} analytics={analytics} onRefresh={refresh} onMessage={setMessage} />}
          {page === "events" && <EventsPage events={events} endpoints={endpoints} selectedEvent={selectedEvent} onSelect={setSelectedEventId} onRefresh={refresh} onMessage={setMessage} />}
          {page === "failure" && <FailureLab endpoints={endpoints} onRefresh={refresh} onMessage={setMessage} onNavigate={navigate} />}
          {page === "store" && <MiniStore orders={orders} endpoints={endpoints} onRefresh={refresh} onMessage={setMessage} onNavigate={navigate} />}
          {page === "inbox" && <ReceiverInbox inbox={inbox} loading={loading} />}
          {page === "quickstart" && <Quickstart quickstart={quickstart} endpoints={endpoints} onMessage={setMessage} />}
          <footer className="pageFoot"><span>Reliable event delivery for the systems behind your product.</span><span>Last synced {lastSync ? lastSync.toLocaleTimeString() : "—"}</span></footer>
        </main>
      </div>
    </div>
  );
}

function Overview({ summary, events, analytics, serviceHealth, loading, lastSync, onNavigate, onSelectEvent }) {
  const first = summary?.counts || {};
  const activeQueue = (first.queued || 0) + (first.scheduled || 0) + (first.delivering || 0);
  const pipelineReady = ["api", "postgres", "redis", "worker"].every((service) => serviceHealth?.[service] === "ok");
  return (
    <>
      <PageHeading eyebrow="Delivery operations" title="Overview" description="A live view of events moving through your delivery pipeline." actions={<button className="button primary" onClick={() => onNavigate("store")}><Icon name="bag" /> Place demo order</button>} />
      <div className="welcomeStrip">
        <div className="welcomeGlyph"><Icon name="activity" /></div>
        <div><strong>Your delivery pipeline is {pipelineReady ? "ready" : loading ? "connecting" : "waiting on a service"}.</strong><p>Send a real order, watch it arrive at the signed receiver, then use Failure Lab to test recovery.</p></div>
        <a href="#failure" onClick={() => onNavigate("failure")}>Open Failure Lab <Icon name="arrow" /></a>
      </div>

      <section className="metricGrid" aria-label="Delivery metrics">
        <MetricCard label="Events processed" value={formatNumber(summary?.total)} detail={`${formatNumber(summary?.last24h)} in the last 24 hours`} icon="layers" trend="neutral" />
        <MetricCard label="Delivery success" value={`${summary?.successRate ?? 0}%`} detail={`${formatNumber(first.succeeded)} delivered`} icon="check" trend="positive" />
        <MetricCard label="In the queue" value={formatNumber(activeQueue)} detail={`${formatNumber(first.scheduled)} waiting for retry`} icon="clock" trend="warning" />
        <MetricCard label="Active endpoints" value={`${summary?.endpoints?.active ?? 0}/${summary?.endpoints?.total ?? 0}`} detail={`${formatNumber(first.failed)} in dead letter`} icon="plug" trend={first.failed ? "negative" : "neutral"} />
      </section>

      <section className="overviewGrid">
        <article className="surface chartPanel">
          <div className="sectionHead"><div><p className="eyebrow">Delivery performance</p><h2>Endpoint health</h2></div><span className="periodTag"><span className="pulseDot" /> Last 24 hours</span></div>
          {analytics.length ? <EndpointHealthRows analytics={analytics} /> : <EmptyState icon="activity" title="No endpoint activity yet" text="Place a MiniStore order or send a test event to start measuring delivery health." action={<button className="button secondary" onClick={() => onNavigate("store")}>Run the sample flow <Icon name="arrow" /></button>} />}
        </article>
        <article className="surface flowPanel">
          <div className="sectionHead"><div><p className="eyebrow">System path</p><h2>How delivery works</h2></div><span className="tinyCode">AT-LEAST-ONCE</span></div>
          <div className="flowDiagram">
            <FlowStep icon="bag" title="Producer" note="MiniStore or API" />
            <span className="flowConnector"><span /></span>
            <FlowStep icon="database" title="Persist + queue" note="Postgres outbox → BullMQ" />
            <span className="flowConnector"><span /></span>
            <FlowStep icon="shield" title="Signed worker" note="Retry with backoff" />
            <span className="flowConnector"><span /></span>
            <FlowStep icon="inbox" title="Receiver" note="Verify + deduplicate" />
          </div>
          <div className="flowFoot"><span><span className="legendDot green" /> Healthy services</span><span><span className="legendDot amber" /> Retriable delivery</span></div>
        </article>
      </section>

      <section className="surface recentPanel">
        <div className="sectionHead"><div><p className="eyebrow">Live stream</p><h2>Recent deliveries</h2></div><button className="textButton" onClick={() => onNavigate("events")}>View event explorer <Icon name="arrow" /></button></div>
        {events.length ? <EventTable events={events.slice(0, 6)} onSelect={onSelectEvent} compact /> : <EmptyState icon="layers" title={loading ? "Connecting to HookGuard…" : "Your event stream is quiet"} text="Create your first order or send a signed API event to see each delivery attempt here." action={<button className="button primary" onClick={() => onNavigate("quickstart")}>View API quickstart <Icon name="arrow" /></button>} />}
      </section>
    </>
  );
}

function EndpointsPage({ endpoints, analytics, onRefresh, onMessage }) {
  const [showForm, setShowForm] = useState(false);
  const [secretReveal, setSecretReveal] = useState(null);
  const [rotateTarget, setRotateTarget] = useState(null);
  const [busyId, setBusyId] = useState("");

  async function submitEndpoint(formData) {
    try {
      const payload = Object.fromEntries(formData.entries());
      payload.destinationType = payload.destinationType || "simulator";
      if (payload.destinationType === "custom") payload.targetUrl = payload.targetUrl.trim();
      for (const key of ["maxAttempts", "backoffBaseMs", "backoffCapMs", "jitterPercent"]) payload[key] = Number(payload[key]);
      const result = await api("/api/endpoints", { method: "POST", body: payload });
      setSecretReveal({ name: result.endpoint.name, secret: result.signingSecret });
      setShowForm(false);
      await onRefresh();
      onMessage({ kind: "success", text: "Endpoint is connected. Copy its signing secret now; it will not be shown again." });
    } catch (error) { onMessage({ kind: "error", text: error.message, persistent: true }); }
  }

  async function toggleEndpoint(endpoint) {
    setBusyId(endpoint.id);
    try {
      await api(`/api/endpoints/${endpoint.id}`, { method: "PATCH", body: { active: !endpoint.active } });
      await onRefresh();
      onMessage({ kind: "success", text: `${endpoint.name} ${endpoint.active ? "paused" : "resumed"}.` });
    } catch (error) { onMessage({ kind: "error", text: error.message, persistent: true }); }
    finally { setBusyId(""); }
  }

  async function sendTest(endpoint) {
    setBusyId(endpoint.id);
    try {
      const result = await api(`/api/endpoints/${endpoint.id}/test`, { method: "POST" });
      await onRefresh();
      onMessage({ kind: "success", text: `Test event ${result.event.id} queued for ${endpoint.name}.` });
    } catch (error) { onMessage({ kind: "error", text: error.message, persistent: true }); }
    finally { setBusyId(""); }
  }

  return (
    <>
      <PageHeading eyebrow="Destinations" title="Endpoints" description="Configure signed destinations, delivery policies, and endpoint health." actions={<button className="button primary" onClick={() => setShowForm(true)}><Icon name="plus" /> Add endpoint</button>} />
      <div className="inlineNotice"><Icon name="shield" /><span>Signing secrets are shown only when created or rotated. External destinations must use HTTPS and resolve to public IP addresses. Pausing an endpoint rejects new events; already accepted events continue to drain.</span></div>
      <div className="endpointGrid">
        {endpoints.map((endpoint) => {
          const health = analytics.find((item) => item.endpointId === endpoint.id);
          return <EndpointCard key={endpoint.id} endpoint={endpoint} health={health} busy={busyId === endpoint.id} onToggle={() => void toggleEndpoint(endpoint)} onTest={() => void sendTest(endpoint)} onRotate={() => setRotateTarget(endpoint)} />;
        })}
        {!endpoints.length && <div className="surface emptyFill"><EmptyState icon="plug" title="No endpoints configured" text="Add a destination to begin delivering signed events." action={<button className="button primary" onClick={() => setShowForm(true)}>Create your first endpoint</button>} /></div>}
      </div>
      {showForm && <Modal title="Connect an endpoint" onClose={() => setShowForm(false)}><EndpointForm onSubmit={submitEndpoint} /></Modal>}
      {rotateTarget && <Modal title="Rotate endpoint secret?" onClose={() => setRotateTarget(null)}><p className="bodyCopy">Requests signed with the current secret will stop verifying immediately. Update the receiver with the new value before sending more events to <strong>{rotateTarget.name}</strong>.</p><div className="modalActions"><button className="button secondary" onClick={() => setRotateTarget(null)}>Keep current secret</button><button className="button primary" onClick={async () => {
        try { const result = await api(`/api/endpoints/${rotateTarget.id}/rotate-secret`, { method: "POST" }); setSecretReveal({ name: rotateTarget.name, secret: result.signingSecret }); setRotateTarget(null); }
        catch (error) { onMessage({ kind: "error", text: error.message, persistent: true }); }
      }}><Icon name="key" /> Rotate secret</button></div></Modal>}
      {secretReveal && <Modal title="Copy your signing secret" onClose={() => setSecretReveal(null)}><p className="bodyCopy">Use this secret to verify HookGuard signatures at <strong>{secretReveal.name}</strong>. It is displayed once and cannot be retrieved later.</p><SecretValue value={secretReveal.secret} onCopied={() => onMessage({ kind: "success", text: "Signing secret copied." })} /><div className="modalActions"><button className="button primary" onClick={() => setSecretReveal(null)}>I saved this secret</button></div></Modal>}
    </>
  );
}

function EndpointCard({ endpoint, health, busy, onToggle, onTest, onRotate }) {
  return (
    <article className="surface endpointCard">
      <div className="endpointTop"><span className={`endpointIcon ${endpoint.active ? "" : "paused"}`}><Icon name="plug" /></span><div className="endpointTitle"><div><h2>{endpoint.name}</h2><span className={`statusPill ${endpoint.active ? "healthy" : "paused"}`}><i />{endpoint.active ? "Accepting events" : "Paused"}</span></div><code>{endpoint.targetUrl}</code></div><button className="iconButton" aria-label={`Rotate signing secret for ${endpoint.name}`} title="Rotate signing secret" onClick={onRotate}><Icon name="key" /></button></div>
      <div className="endpointStats"><div><span>Success rate</span><strong>{health?.successRate ?? 0}%</strong></div><div><span>Avg latency</span><strong>{formatLatency(health?.averageLatencyMs || 0)}</strong></div><div><span>Events</span><strong>{endpoint.eventCount}</strong></div><div><span>Retry policy</span><strong>{endpoint.maxAttempts} attempts</strong></div></div>
      <div className="endpointPolicy"><span><Icon name="rotate" /> {endpoint.backoffBaseMs}ms base · {endpoint.backoffCapMs}ms cap · {endpoint.jitterPercent}% jitter</span><span><Icon name="shield" /> HMAC-SHA256</span></div>
      <div className="endpointActions"><button className="button secondary" disabled={busy || !endpoint.active} onClick={onTest}>{busy ? <Spinner /> : <Icon name="send" />} Send test event</button><button className="textButton" disabled={busy} onClick={onToggle}>{endpoint.active ? "Stop new events" : "Resume intake"}</button></div>
    </article>
  );
}

function EndpointForm({ onSubmit }) {
  const [destinationType, setDestinationType] = useState("simulator");
  return <form className="formStack" onSubmit={(event) => { event.preventDefault(); void onSubmit(new FormData(event.currentTarget)); }}>
    <label>Endpoint name<input name="name" defaultValue="Order notification receiver" required minLength="2" maxLength="80" /></label>
    <div className="fieldLabel">Destination type</div>
    <div className="choiceRow"><button type="button" className={destinationType === "simulator" ? "choice active" : "choice"} onClick={() => setDestinationType("simulator")}><Icon name="flask" /><span><strong>Failure Lab receiver</strong><small>Local and safe for demos</small></span></button><button type="button" className={destinationType === "custom" ? "choice active" : "choice"} onClick={() => setDestinationType("custom")}><Icon name="globe" /><span><strong>External HTTPS URL</strong><small>Public HTTPS destinations only</small></span></button></div>
    <input type="hidden" name="destinationType" value={destinationType} />
    {destinationType === "custom" && <label>Destination URL<input name="targetUrl" placeholder="https://api.example.com/webhooks" required type="url" /><small className="fieldHint">Local, private, and reserved network addresses are blocked.</small></label>}
    <div className="formColumns"><label>Max attempts<input name="maxAttempts" type="number" min="1" max="8" defaultValue="3" /></label><label>Backoff base (ms)<input name="backoffBaseMs" type="number" min="100" max="60000" defaultValue="700" /></label><label>Backoff cap (ms)<input name="backoffCapMs" type="number" min="100" max="300000" defaultValue="6000" /></label><label>Jitter (%)<input name="jitterPercent" type="number" min="0" max="50" defaultValue="20" /></label></div>
    <div className="modalActions"><button className="button primary" type="submit"><Icon name="plug" /> Create signed endpoint</button></div>
  </form>;
}

function FailureLab({ endpoints, onRefresh, onMessage, onNavigate }) {
  const labEndpoints = endpoints.filter((item) => item.targetUrl.includes("/receiver/"));
  const [endpointId, setEndpointId] = useState(labEndpoints[0]?.id || "");
  const endpoint = labEndpoints.find((item) => item.id === endpointId) || labEndpoints[0];
  const [mode, setMode] = useState(endpoint?.failureMode || "retry_then_success");
  const [failureCount, setFailureCount] = useState(endpoint?.failuresBeforeSuccess ?? 2);
  const [statusCode, setStatusCode] = useState(endpoint?.failureStatusCode ?? 500);
  const [delay, setDelay] = useState(endpoint?.simulatedDelayMs ?? 4500);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!endpoint) return;
    setMode(endpoint.failureMode);
    setFailureCount(endpoint.failuresBeforeSuccess);
    setStatusCode(endpoint.failureStatusCode);
    setDelay(endpoint.simulatedDelayMs);
  }, [endpoint?.id]);

  async function save() {
    if (!endpoint) return;
    setBusy(true);
    try {
      await api(`/api/endpoints/${endpoint.id}`, { method: "PATCH", body: { failureMode: mode, failuresBeforeSuccess: Number(failureCount), failureStatusCode: Number(statusCode), simulatedDelayMs: Number(delay) } });
      await onRefresh();
      onMessage({ kind: "success", text: "Failure profile saved. New deliveries will use this behavior." });
    } catch (error) { onMessage({ kind: "error", text: error.message, persistent: true }); }
    finally { setBusy(false); }
  }

  async function runScenario() {
    if (!endpoint) return;
    setBusy(true);
    try {
      await api(`/api/endpoints/${endpoint.id}`, { method: "PATCH", body: { failureMode: mode, failuresBeforeSuccess: Number(failureCount), failureStatusCode: Number(statusCode), simulatedDelayMs: Number(delay) } });
      const result = await api(`/api/endpoints/${endpoint.id}/test`, { method: "POST" });
      await onRefresh();
      onMessage({ kind: "success", text: `Scenario started with event ${result.event.id}. Watch its attempts in Event Explorer.` });
      onNavigate("events");
    } catch (error) { onMessage({ kind: "error", text: error.message, persistent: true }); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHeading eyebrow="Resilience testing" title="Failure Lab" description="Inject controlled failures and watch retries, backoff, signatures, and recovery happen for real." />
      {!labEndpoints.length ? <div className="surface"><EmptyState icon="flask" title="Add a simulator endpoint first" text="The Failure Lab needs a local receiver endpoint to inject controlled failures safely." action={<button className="button primary" onClick={() => onNavigate("endpoints")}>Configure an endpoint</button>} /></div> : <div className="labLayout">
        <section className="surface labControls"><div className="sectionHead"><div><p className="eyebrow">Scenario setup</p><h2>Choose a failure profile</h2></div><span className="labBadge"><Icon name="flask" /> SANDBOX</span></div>
          <label>Destination<select value={endpoint?.id || ""} onChange={(event) => setEndpointId(event.target.value)}>{labEndpoints.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <label>Response behavior<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="success">Always return 200</option><option value="retry_then_success">Fail, then recover</option><option value="always_fail">Always fail</option><option value="rate_limit">Return HTTP 429</option><option value="timeout">Exceed the request timeout</option></select></label>
          {mode === "retry_then_success" && <label>Failures before recovery<input type="number" min="0" max="8" value={failureCount} onChange={(event) => setFailureCount(event.target.value)} /></label>}
          {!["success", "timeout", "rate_limit"].includes(mode) && <label>Failure status code<input type="number" min="400" max="599" value={statusCode} onChange={(event) => setStatusCode(event.target.value)} /></label>}
          {mode === "timeout" && <label>Receiver delay (ms)<input type="number" min="0" max="10000" value={delay} onChange={(event) => setDelay(event.target.value)} /></label>}
          <div className="labButtons"><button className="button secondary" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : <Icon name="save" />} Save profile</button><button className="button primary" disabled={busy || !endpoint?.active} onClick={() => void runScenario()}>{busy ? <Spinner /> : <Icon name="play" />} Run scenario</button></div>
          <div className="labHint"><Icon name="info" /><span>The worker makes real HTTP requests to this local receiver. Failed attempts are recorded and retried using the endpoint policy.</span></div>
        </section>
        <section className="surface scenarioPreview"><div className="sectionHead"><div><p className="eyebrow">Expected behavior</p><h2>Delivery simulation</h2></div><span className="statusPill healthy"><i /> Isolated</span></div>
          <div className="scenarioSteps"><ScenarioStep number="01" title="Persist event" text="Postgres records the event and its outbox job in one transaction." /><ScenarioStep number="02" title="Inject destination behavior" text={scenarioDescription(mode, failureCount, statusCode, delay)} /><ScenarioStep number="03" title="Recover or dead-letter" text={`Up to ${endpoint?.maxAttempts || 3} attempts with capped exponential backoff and ${endpoint?.jitterPercent || 0}% jitter.`} /></div>
          <div className="conceptTags"><span>Fault injection</span><span>At-least-once delivery</span><span>Exponential backoff</span><span>Dead-letter recovery</span></div>
        </section>
      </div>}
    </>
  );
}

function EventsPage({ events, endpoints, selectedEvent, onSelect, onRefresh, onMessage }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [endpointFilter, setEndpointFilter] = useState("");
  const [payloadText, setPayloadText] = useState(JSON.stringify(defaultPayload, null, 2));
  const [submitEndpoint, setSubmitEndpoint] = useState(endpoints[0]?.id || "");
  const [key, setKey] = useState("");
  const [showSend, setShowSend] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!submitEndpoint && endpoints[0]) setSubmitEndpoint(endpoints[0].id); }, [endpoints, submitEndpoint]);
  const filtered = useMemo(() => events.filter((event) => {
    const matchesQuery = !query || `${event.id} ${event.idempotencyKey} ${event.endpointName}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (!statusFilter || event.status === statusFilter) && (!endpointFilter || event.endpointId === endpointFilter);
  }), [events, query, statusFilter, endpointFilter]);

  async function sendEvent(event) {
    event.preventDefault();
    let payload;
    try { payload = JSON.parse(payloadText); } catch { onMessage({ kind: "error", text: "Payload must be valid JSON.", persistent: true }); return; }
    setBusy(true);
    try {
      const result = await api("/api/events", { method: "POST", body: { endpointId: submitEndpoint, payload, idempotencyKey: key || undefined } });
      await onRefresh();
      onSelect(result.event.id);
      setShowSend(false);
      onMessage({ kind: "success", text: `Event ${result.event.id} accepted and written to the delivery outbox.` });
    } catch (error) { onMessage({ kind: "error", text: error.message, persistent: true }); }
    finally { setBusy(false); }
  }

  async function replay() {
    if (!selectedEvent) return;
    setBusy(true);
    try {
      await api(`/api/events/${selectedEvent.id}/replay`, { method: "POST" });
      await onRefresh();
      onMessage({ kind: "success", text: "Replay queued as a new delivery run. Original attempts remain in the timeline." });
    } catch (error) { onMessage({ kind: "error", text: error.message, persistent: true }); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHeading eyebrow="Delivery records" title="Event explorer" description="Search every event, inspect response details, and replay completed or dead-lettered deliveries." actions={<button className="button primary" onClick={() => setShowSend((visible) => !visible)}><Icon name="send" /> Send event</button>} />
      {showSend && <form className="surface sendEventForm" onSubmit={sendEvent}><div className="sectionHead"><div><p className="eyebrow">Producer API</p><h2>Submit an event</h2></div><button className="iconButton" type="button" aria-label="Close" onClick={() => setShowSend(false)}>×</button></div><div className="formColumns"><label>Destination<select value={submitEndpoint} onChange={(event) => setSubmitEndpoint(event.target.value)}>{endpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>)}</select></label><label>Idempotency key <span className="optional">optional</span><input value={key} onChange={(event) => setKey(event.target.value)} placeholder="invoice:inv_01HT9K" /></label></div><label>JSON payload<textarea spellCheck="false" value={payloadText} onChange={(event) => setPayloadText(event.target.value)} /></label><button className="button primary" disabled={busy || !endpoints.length}>{busy ? <Spinner /> : <Icon name="send" />} Queue event</button></form>}
      <div className="eventExplorerLayout">
        <section className="surface explorerTable">
          <div className="filterBar"><label className="searchInput"><Icon name="search" /><input aria-label="Search events" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search event ID, key, endpoint…" /></label><select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option><option value="queued">Queued</option><option value="scheduled">Retrying</option><option value="delivering">Delivering</option><option value="succeeded">Delivered</option><option value="failed">Dead letter</option></select><select aria-label="Filter by endpoint" value={endpointFilter} onChange={(event) => setEndpointFilter(event.target.value)}><option value="">All endpoints</option>{endpoints.map((endpoint) => <option value={endpoint.id} key={endpoint.id}>{endpoint.name}</option>)}</select></div>
          {filtered.length ? <EventTable events={filtered} selectedId={selectedEvent?.id} onSelect={onSelect} /> : <EmptyState icon="search" title="No matching events" text="Change the filters or send a new event to see delivery activity." />}
        </section>
        <aside className="surface eventDetail">
          {selectedEvent ? <EventDetail event={selectedEvent} busy={busy} onReplay={() => void replay()} /> : <EmptyState icon="layers" title="Select an event" text="Choose a row to inspect its payload, signatures, and attempt history." />}
        </aside>
      </div>
    </>
  );
}

function EventDetail({ event, busy, onReplay }) {
  const canReplay = ["failed", "succeeded"].includes(event.status);
  const groupedRuns = groupBy(event.attempts, (attempt) => attempt.runNumber);
  const runs = Object.entries(groupedRuns).sort(([a], [b]) => Number(a) - Number(b));
  return <>
    <div className="detailTop"><div><p className="eyebrow">Event detail</p><h2>{event.payload?.event || "Webhook event"}</h2></div><StatusPill status={event.status} /></div>
    <div className="detailId"><code>{event.id}</code><CopyButton value={event.id} /></div>
    <div className="detailMeta"><div><span>Destination</span><strong>{event.endpointName}</strong></div><div><span>Attempts</span><strong>{event.attemptCount} / {event.maxAttempts}</strong></div><div><span>Run</span><strong>{event.replayCount + 1}</strong></div><div><span>Idempotency key</span><code>{event.idempotencyKey}</code></div></div>
    <div className="detailActions">{canReplay && <button className="button secondary" onClick={onReplay} disabled={busy}>{busy ? <Spinner /> : <Icon name="rotate" />} Replay event</button>}<span className="tinyCode">{event.status === "failed" ? "DEAD LETTER" : event.status.toUpperCase()}</span></div>
    <div className="timelineHeading"><strong>Delivery timeline</strong><span>{event.attempts.length} attempt{event.attempts.length === 1 ? "" : "s"}</span></div>
    {!event.attempts.length ? <div className="waitingLine"><span className="pulseDot" /> Waiting for a worker to pick up this event.</div> : <div className="attemptRuns">{runs.map(([run, attempts]) => <div className="attemptRun" key={run}><div className="runLabel">{Number(run) === 0 ? "Initial delivery" : `Replay run ${run}`}<span>{attempts.length} attempt{attempts.length === 1 ? "" : "s"}</span></div>{attempts.map((attempt) => <div className={`attemptRow ${attempt.ok ? "success" : "failure"}`} key={`${run}:${attempt.attemptNumber}`}><span className="attemptMarker"><Icon name={attempt.ok ? "check" : "cross"} /></span><div className="attemptBody"><div className="attemptHead"><strong>Attempt {attempt.attemptNumber}</strong><span>{formatTime(attempt.finishedAt)}</span></div><div className="attemptResult"><span>{attempt.ok ? "Delivered" : attempt.error || "Request failed"}</span><span>{attempt.statusCode ? `HTTP ${attempt.statusCode}` : "No response"}</span><span>{formatLatency(attempt.latencyMs)}</span></div>{attempt.signatureAlgorithm && <div className="signatureMeta"><Icon name="shield" /> {attempt.signatureAlgorithm} · signed {formatTime(new Date(attempt.signatureTimestamp * 1000).toISOString())}</div>}{attempt.scheduledDelayMs > 0 && <div className="retryDelay"><Icon name="clock" /> Next retry in {formatLatency(attempt.scheduledDelayMs)}</div>}{attempt.responseBody && <details className="responseDetails"><summary>Receiver response</summary><pre>{attempt.responseBody}</pre></details>}</div></div>)}</div>)}</div>}
    <div className="payloadBlock"><div className="sectionMiniHead"><strong>Payload</strong><CopyButton value={JSON.stringify(event.payload, null, 2)} /></div><pre>{JSON.stringify(event.payload, null, 2)}</pre></div>
    <div className="detailFooter"><span>Created {formatDateTime(event.createdAt)}</span>{event.nextAttemptAt && <span>Next attempt {formatTime(event.nextAttemptAt)}</span>}</div>
  </>;
}

function MiniStore({ orders, endpoints, onRefresh, onMessage, onNavigate }) {
  const [name, setName] = useState("Alex Morgan");
  const [busy, setBusy] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);
  const defaultEndpoint = endpoints.find((item) => item.id === "demo-receiver") || endpoints.find((item) => item.active);

  async function placeOrder() {
    setBusy(true);
    try {
      const result = await api("/api/store/orders", { method: "POST", body: { customerName: name, itemName: "Studio Headphones", amountCents: 12900, endpointId: defaultEndpoint?.id } });
      setLastOrder(result);
      await onRefresh();
      onMessage({ kind: "success", text: `${result.order.id} placed. HookGuard has queued order.created for signed delivery.` });
    } catch (error) { onMessage({ kind: "error", text: error.message, persistent: true }); }
    finally { setBusy(false); }
  }

  return <>
    <PageHeading eyebrow="Connected demo application" title="MiniStore" description="A small producer app proves the webhook system solves a business problem end to end." actions={<span className="demoLive"><span className="pulseDot" /> Connected to HookGuard</span>} />
    <div className="storeLayout">
      <section className="storefront">
        <div className="storeBanner"><div className="storeBadge">MINISTORE / CHECKOUT</div><p>FIELD NOTES / 2026</p></div>
        <div className="productCard"><div className="productArt"><div className="headphoneShape"><span /><i /></div><span className="artStamp">SOUND<br />NO. 04</span></div><div className="productInfo"><div className="productTag">AUDIO · WIRELESS</div><h2>Studio Headphones</h2><p>Balanced sound. All-day comfort. Designed for the long way around.</p><div className="productBuy"><strong>₹129.00</strong><span>In stock · ships tomorrow</span></div></div></div>
        <div className="checkoutPanel"><div className="sectionMiniHead"><strong>Order details</strong><span>DEMO CHECKOUT</span></div><label>Customer name<input value={name} onChange={(event) => setName(event.target.value)} /></label><div className="checkoutTotal"><span>Total</span><strong>₹129.00</strong></div><button className="button primary wide" disabled={busy || !defaultEndpoint?.active} onClick={() => void placeOrder()}>{busy ? <Spinner /> : <Icon name="bag" />} Place order · emit webhook</button><p className="finePrint">This creates a persistent order, a signed <code>order.created</code> event, and an outbox job.</p></div>
      </section>
      <aside className="storeAside"><div className="surface demoSteps"><div className="sectionHead"><div><p className="eyebrow">Live integration</p><h2>Follow the event</h2></div><span className="liveTag"><span className="pulseDot" /> LIVE</span></div><div className="integrationFlow"><FlowStep icon="bag" title="MiniStore" note="Order is placed" /><span className="flowConnector"><span /></span><FlowStep icon="queue" title="HookGuard" note="Event is signed + queued" /><span className="flowConnector"><span /></span><FlowStep icon="inbox" title="Receiver inbox" note="Order notification arrives" /></div><button className="textButton" onClick={() => onNavigate("inbox")}>Open receiver inbox <Icon name="arrow" /></button></div>
        <div className="surface orderHistory"><div className="sectionHead"><div><p className="eyebrow">Recent activity</p><h2>Orders</h2></div><span className="countTag">{orders.length}</span></div>{orders.length ? <div className="orderList">{orders.slice(0, 5).map((order) => <div className="orderRow" key={order.id}><span className="orderThumb"><Icon name="bag" /></span><div><strong>{order.itemName}</strong><small>{order.id} · {order.customerName}</small></div><StatusPill status={order.deliveryStatus} /></div>)}</div> : <div className="emptyCompact">Your first demo order will appear here.</div>}{lastOrder && <button className="textButton" onClick={() => onNavigate("events")}>Inspect event {lastOrder.event.id.slice(0, 10)}… <Icon name="arrow" /></button>}</div>
      </aside>
    </div>
  </>;
}

function ReceiverInbox({ inbox, loading }) {
  const [selected, setSelected] = useState("");
  const selectedReceipt = inbox.find((receipt) => String(receipt.id) === selected) || inbox[0];
  return <>
    <PageHeading eyebrow="Destination application" title="Receiver inbox" description="The demo receiver verifies HMAC signatures and deduplicates retries before creating a business-side receipt." actions={<span className="statusPill healthy"><i /> Signature verification on</span>} />
    <div className="inboxSummary"><div className="inboxSummaryMark"><Icon name="shield" /></div><div><strong>Signed receiver is listening</strong><p>Every incoming delivery checks the timestamped HMAC-SHA256 signature before it can enter this inbox.</p></div><span className="securityChip"><Icon name="check" /> VERIFIED</span></div>
    <div className="inboxLayout"><section className="surface inboxList"><div className="sectionHead"><div><p className="eyebrow">Business receipts</p><h2>Received events</h2></div><span className="countTag">{inbox.length}</span></div>{inbox.length ? inbox.map((receipt) => <button className={`inboxReceipt ${String(receipt.id) === String(selectedReceipt?.id) ? "active" : ""}`} key={receipt.id} onClick={() => setSelected(String(receipt.id))}><span className="receiptIcon"><Icon name="bell" /></span><span className="receiptCopy"><strong>{receipt.payload?.event || "Webhook received"}</strong><small>{receipt.payload?.orderId || receipt.eventId} · {formatTime(receipt.receivedAt)}</small></span><span className="signatureTiny"><Icon name="check" /> HMAC</span></button>) : <EmptyState icon="inbox" title={loading ? "Connecting to receiver…" : "No receipts yet"} text="Place an order in MiniStore to send the first signed notification." />}</section>
      <aside className="surface receiptDetail">{selectedReceipt ? <><div className="detailTop"><div><p className="eyebrow">Verified receipt</p><h2>{selectedReceipt.payload?.event || "Webhook event"}</h2></div><span className="securityChip"><Icon name="check" /> VERIFIED</span></div><div className="receiptFields"><div><span>Event ID</span><code>{selectedReceipt.eventId}</code></div><div><span>Idempotency key</span><code>{selectedReceipt.idempotencyKey}</code></div><div><span>Received</span><strong>{formatDateTime(selectedReceipt.receivedAt)}</strong></div><div><span>Receiver</span><strong>{selectedReceipt.endpointName}</strong></div></div><div className="payloadBlock"><div className="sectionMiniHead"><strong>Accepted payload</strong><CopyButton value={JSON.stringify(selectedReceipt.payload, null, 2)} /></div><pre>{JSON.stringify(selectedReceipt.payload, null, 2)}</pre></div><div className="dedupeNote"><Icon name="shield" /><span>Retries share the same event ID. The receiver stores one business receipt and marks later requests as duplicates.</span></div></> : <EmptyState icon="inbox" title="Select a receipt" text="Signed event details appear here after a delivery succeeds." />}</aside></div>
  </>;
}

function Quickstart({ quickstart, endpoints, onMessage }) {
  const [copied, setCopied] = useState("");
  const endpointId = quickstart?.demoEndpointId || endpoints[0]?.id || "<endpoint_id>";
  const apiUrl = quickstart?.apiBaseUrl || "http://127.0.0.1:3000";
  const apiKey = quickstart?.apiKey || "<configure HOOKGUARD_API_KEY>";
  const curl = [
    `curl ${apiUrl}/v1/events`,
    `-H 'Authorization: Bearer ${apiKey}'`,
    "-H 'Content-Type: application/json'",
    `-d '{"endpointId":"${endpointId}","idempotencyKey":"invoice:inv_01HT9K","payload":{"event":"invoice.paid","invoiceId":"inv_01HT9K"}}'`
  ].join(" \\\n");
  const nodeSnippet = `import { createHmac, timingSafeEqual } from "node:crypto";\n\nfunction verifyHookguard(rawBody, secret, signatureHeader) {\n  const fields = Object.fromEntries(signatureHeader.split(",").map((part) => part.split("=")));\n  const age = Math.abs(Date.now() / 1000 - Number(fields.t));\n  if (age > 300) return false; // reject stale requests\n\n  const expected = createHmac("sha256", secret)\n    .update(fields.t + ".")\n    .update(rawBody)\n    .digest();\n  const received = Buffer.from(fields.v1, "hex");\n  return received.length === expected.length && timingSafeEqual(received, expected);\n}`;

  async function copy(value, name) {
    try { await navigator.clipboard.writeText(value); setCopied(name); window.setTimeout(() => setCopied(""), 1600); onMessage({ kind: "success", text: `${name} copied to clipboard.` }); }
    catch { onMessage({ kind: "error", text: "Clipboard access is unavailable in this browser.", persistent: true }); }
  }

  return <>
    <PageHeading eyebrow="Developer docs" title="API quickstart" description="Send your first event in one request, then verify signed deliveries at your endpoint." actions={<span className="tinyCode">REST API · V1</span>} />
    <div className="quickstartLayout"><div className="quickstartMain"><section className="surface quickCard"><div className="stepNumber">01</div><div className="quickContent"><p className="eyebrow">Credentials</p><h2>Use the local sandbox key</h2><p>This test key is for the self-hosted local demo. Set <code>HOOKGUARD_API_KEY</code> in your environment before sharing a deployment.</p><SecretValue value={apiKey} onCopied={() => copy(apiKey, "API key")} /><div className="credentialFoot"><span><Icon name="shield" /> Bearer token required on <code>/v1/events</code></span><span className="envChip">LOCAL ONLY</span></div></div></section>
      <section className="surface quickCard"><div className="stepNumber">02</div><div className="quickContent"><p className="eyebrow">Create event</p><h2>Queue a signed webhook</h2><p>HookGuard returns after persistence. A separate worker signs and delivers the event in the background.</p><CodeBlock language="cURL" code={curl} onCopy={() => copy(curl, "cURL request")} copied={copied === "cURL request"} /><div className="quickFacts"><span><Icon name="check" /> 202 Accepted</span><span><Icon name="check" /> Idempotency key</span><span><Icon name="check" /> Exponential retry</span></div></div></section>
      <section className="surface quickCard"><div className="stepNumber">03</div><div className="quickContent"><p className="eyebrow">Verify receiver</p><h2>Validate the signature</h2><p>HookGuard signs <code>timestamp + raw body</code>. Read the raw request bytes before JSON parsing and compare signatures in constant time.</p><CodeBlock language="Node.js" code={nodeSnippet} onCopy={() => copy(nodeSnippet, "Node.js verifier")} copied={copied === "Node.js verifier"} /></div></section></div>
      <aside className="quickSidebar"><section className="surface endpointQuick"><div className="sectionHead"><div><p className="eyebrow">Ready to use</p><h2>Destination</h2></div><Icon name="plug" /></div><p className="endpointGuide">Create one in <strong>Endpoints → Add endpoint</strong>. Choose the local simulator for a safe demo or enter a public HTTPS receiver. Save the signing secret shown after creation.</p>{endpoints.slice(0, 4).map((endpoint) => <div className="quickEndpoint" key={endpoint.id}><span className="legendDot green" /><div><strong>{endpoint.name}</strong><small><code>{endpoint.id}</code></small></div><CopyButton value={endpoint.id} /></div>)}{!endpoints.length && <p className="muted">Create an endpoint before sending events.</p>}</section>
        <section className="surface headerRef"><p className="eyebrow">Delivery headers</p><div><code>x-hookguard-event-id</code><span>Stable event identifier</span></div><div><code>x-idempotency-key</code><span>Deduplicate business effects</span></div><div><code>x-hookguard-attempt</code><span>Attempt number in current run</span></div><div><code>x-hookguard-signature</code><span>Timestamp + HMAC-SHA256</span></div><div><code>x-hookguard-timestamp</code><span>Unix time for replay checks</span></div></section>
        <div className="quickWarning"><Icon name="info" /><span>The sample receiver is a local demo. Use HTTPS, secret rotation, timestamp validation, and idempotent processing for real destinations.</span></div></aside></div>
  </>;
}

function EventTable({ events, selectedId, onSelect, compact = false }) {
  return <div className={`tableWrap ${compact ? "compact" : ""}`}><table><thead><tr><th>Event</th><th>Endpoint</th><th>Status</th><th>Attempts</th><th>Created</th></tr></thead><tbody>{events.map((event) => <tr className={selectedId === event.id ? "selectedRow" : ""} key={event.id} onClick={() => onSelect(event.id)} tabIndex="0" onKeyDown={(keyEvent) => { if (keyEvent.key === "Enter") onSelect(event.id); }}><td><div className="tableEvent"><span className={`eventTypeIcon ${event.status}`}><Icon name={event.status === "failed" ? "warning" : "layers"} /></span><span><strong>{event.payload?.event || "webhook.event"}</strong><code>{event.id.slice(0, 18)}…</code></span></div></td><td>{event.endpointName}</td><td><StatusPill status={event.status} /></td><td><span className="attemptCount">{event.attemptCount}<i>/</i>{event.maxAttempts}</span></td><td>{formatTime(event.createdAt)}</td></tr>)}</tbody></table></div>;
}

function EndpointHealthRows({ analytics }) {
  return <div className="healthRows">{analytics.map((item) => <div className="healthRow" key={item.endpointId}><span className="healthMark"><Icon name="plug" /></span><div className="healthName"><strong>{item.name}</strong><small>{item.events} events in last 24 hours</small></div><div className="healthProgress"><span><i style={{ width: `${item.successRate}%` }} /></span><small>{item.successRate}% success</small></div><div className="healthLatency"><strong>{formatLatency(item.averageLatencyMs)}</strong><small>avg latency</small></div><div className={`healthState ${item.failed ? "hasFailures" : ""}`}><i />{item.failed ? `${item.failed} failed` : "Operational"}</div></div>)}</div>;
}

function MetricCard({ label, value, detail, icon, trend }) {
  return <article className={`metricCard ${trend}`}><div className="metricTop"><span>{label}</span><span className="metricIcon"><Icon name={icon} /></span></div><strong className="metricValue">{value}</strong><small>{detail}</small></article>;
}

function PageHeading({ eyebrow, title, description, actions }) {
  return <div className="pageHeading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="pageDescription">{description}</p></div>{actions && <div className="headingActions">{actions}</div>}</div>;
}

function FlowStep({ icon, title, note }) {
  return <div className="flowStep"><span className="flowIcon"><Icon name={icon} /></span><strong>{title}</strong><small>{note}</small></div>;
}

function ScenarioStep({ number, title, text }) {
  return <div className="scenarioStep"><span>{number}</span><div><strong>{title}</strong><p>{text}</p></div><Icon name="check" /></div>;
}

function ServiceRow({ label, status }) {
  const online = status === "ok";
  return <div className="serviceRow"><span>{label}</span><span className={online ? "serviceOn" : "serviceOff"}><i />{status ? (online ? "Connected" : "Degraded") : "Checking"}</span></div>;
}

function StatusPill({ status }) {
  const labels = { succeeded: "Delivered", failed: "Dead letter", scheduled: "Retrying", delivering: "Sending", queued: "Queued" };
  return <span className={`statusPill ${status}`}><i />{labels[status] || status}</span>;
}

function EmptyState({ icon, title, text, action }) {
  return <div className="emptyState"><span className="emptyIcon"><Icon name={icon} /></span><h3>{title}</h3><p>{text}</p>{action && <div className="emptyAction">{action}</div>}</div>;
}

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="modalBackdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modalHead"><h2>{title}</h2><button className="iconButton" aria-label="Close dialog" onClick={onClose}>×</button></div>{children}</section></div>;
}

function SecretValue({ value, onCopied }) {
  const [revealed, setRevealed] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(value); onCopied?.(); }
    catch { setRevealed(true); }
  }
  return <div className="secretValue"><code>{revealed ? value : `${value.slice(0, 12)}${"•".repeat(Math.max(8, value.length - 12))}`}</code><button type="button" onClick={() => setRevealed((shown) => !shown)}>{revealed ? "Hide" : "Reveal"}</button><button type="button" onClick={() => void copy()}><Icon name="copy" /> Copy</button></div>;
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  return <button className="copyButton" type="button" aria-label="Copy to clipboard" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1300); } catch {} }}><Icon name={copied ? "check" : "copy"} />{copied ? "Copied" : "Copy"}</button>;
}

function CodeBlock({ language, code, onCopy, copied }) {
  return <div className="codeBlock"><div className="codeHead"><span><i />{language}</span><button onClick={onCopy}><Icon name="copy" /> {copied ? "Copied" : "Copy"}</button></div><pre>{code}</pre></div>;
}

function Spinner() { return <span className="spinner" aria-label="Loading" />; }

function Icon({ name }) {
  const paths = {
    hook: <><path d="M9 14a4 4 0 0 1 0-8h2" /><path d="M15 10a4 4 0 0 1 0 8h-2" /><path d="m8 16 8-8" /><path d="M12 6V3" /><path d="M12 21v-3" /></>,
    grid: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="5" rx="2" /><rect x="13" y="10" width="8" height="11" rx="2" /><rect x="3" y="13" width="8" height="8" rx="2" /></>,
    plug: <><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M6 8h12v4a6 6 0 0 1-12 0V8Z" /></>,
    layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></>,
    flask: <><path d="M9 3h6" /><path d="M10 3v6.5L4.5 19a1.8 1.8 0 0 0 1.6 2.7h11.8a1.8 1.8 0 0 0 1.6-2.7L14 9.5V3" /><path d="M7 16h10" /></>,
    bag: <><path d="M5 8h14l1 13H4L5 8Z" /><path d="M9 9V6a3 3 0 0 1 6 0v3" /></>,
    inbox: <><path d="M4 4h16l2 11v5H2v-5L4 4Z" /><path d="M2 14h6l2 3h4l2-3h6" /></>,
    code: <><path d="m8 8-4 4 4 4" /><path d="m16 8 4 4-4 4" /><path d="m14 5-4 14" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12" /><path d="M18.4 15a7 7 0 0 1-11.6 2L4 12" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    warning: <><path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
    queue: <><path d="M4 5h16" /><path d="M4 10h11" /><path d="M4 15h8" /><path d="M4 20h16" /><circle cx="18" cy="12" r="2" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    rotate: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M5.6 9A7 7 0 0 1 17 6l3 6" /><path d="M18.4 15A7 7 0 0 1 7 18l-3-6" /></>,
    key: <><circle cx="8" cy="15" r="5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3L22 7l-3-3" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
    play: <path d="m8 5 12 7-12 7V5Z" />,
    save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" /><path d="M17 21v-8H7v8" /><path d="M7 3v5h8" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    cross: <><path d="m6 6 12 12" /><path d="M18 6 6 18" /></>,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 0 1 0 18" /><path d="M12 3a15 15 0 0 0 0 18" /></>,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>
  };
  return <svg className="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.activity}</svg>;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) throw new Error(payload.error?.message || `Request failed with HTTP ${response.status}.`);
  return payload;
}

function formatNumber(value) { return new Intl.NumberFormat("en-IN").format(value || 0); }
function formatLatency(value) { return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`; }
function formatTime(value) { return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"; }
function formatDateTime(value) { return value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"; }
function scenarioDescription(mode, failures, status, delay) {
  if (mode === "success") return "Return HTTP 200 on the first request; verify normal delivery and signature handling.";
  if (mode === "retry_then_success") return `Return HTTP ${status} for ${failures} attempt${Number(failures) === 1 ? "" : "s"}, then accept the next request.`;
  if (mode === "always_fail") return `Return HTTP ${status} until the retry limit is exhausted and the event enters the dead-letter state.`;
  if (mode === "rate_limit") return "Return HTTP 429 so the worker records throttling and retries with backoff.";
  return `Hold the response for ${delay}ms, past the worker timeout, then let the next attempt run.`;
}
function groupBy(values, key) { return values.reduce((groups, value) => { const group = key(value); (groups[group] ||= []).push(value); return groups; }, {}); }

createRoot(document.getElementById("root")).render(<App />);
