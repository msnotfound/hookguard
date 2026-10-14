import "./landing.css";

const steps = [
  { number: "01", title: "Accept once", copy: "Persist the event and its delivery intent in one Postgres transaction." },
  { number: "02", title: "Deliver safely", copy: "A worker signs each request and applies bounded retries with backoff." },
  { number: "03", title: "See every attempt", copy: "Inspect responses, replay completed runs, and test failures in a safe lab." }
];

const capabilities = [
  { code: "OUTBOX", title: "No lost handoffs", copy: "The event and its queue handoff commit together, so a process restart does not silently drop accepted work." },
  { code: "HMAC SHA-256", title: "Receivers can verify", copy: "Each outbound request carries a timestamped signature created with its endpoint secret." },
  { code: "AT-LEAST-ONCE", title: "Recovery stays visible", copy: "Retries, rate limits, dead letters, and replays all leave an inspectable delivery history." }
];

export default function LandingPage({ publicDemo = false }) {
  return (
    <main className="landingPage">
      <header className="landingNav">
        <a className="landingBrand" href="/" aria-label="HookGuard home">
          <span className="landingMark"><HookMark /></span>
          <span><strong>hookguard</strong><small>DELIVERY CONTROL PLANE</small></span>
        </a>
        <nav className="landingLinks" aria-label="Main navigation">
          <a href="#flow">How it works</a>
          <a href="#capabilities">Capabilities</a>
          <a href="https://github.com/msnotfound/hookguard" target="_blank" rel="noreferrer">Source <ArrowUpRight /></a>
        </nav>
        <a className="landingNavCta" href="/app">Open dashboard <ArrowRight /></a>
      </header>

      <section className="landingHero">
        <div className="heroCopy">
          <p className="landingKicker"><span className="kickerLine" /> WEBHOOK DELIVERY, MADE OBSERVABLE</p>
          <h1>Every event<br />gets a <em>second chance.</em></h1>
          <p className="heroIntro">HookGuard receives your events, delivers them with signed requests, and keeps the full retry story in view when a receiver goes quiet.</p>
          <div className="heroActions">
            <a className="heroPrimary" href="/app">Explore the live console <ArrowRight /></a>
            <a className="heroSecondary" href="#flow">See the delivery flow <ArrowDown /></a>
          </div>
          <div className="heroNote"><span className="statusPip" /> A working webhook pipeline with a built-in receiver and failure lab</div>
          {publicDemo && <p className="publicDemoCopy">The portfolio console is a shared demo with synthetic data and a built-in simulated destination.</p>}
        </div>

        <div className="heroVisual" aria-label="Illustration of a webhook event being retried and delivered">
          <div className="visualHeader"><span><i /> SAMPLE DELIVERY TRACE</span><code>evt_01J9WQ8C</code></div>
          <div className="traceEvent">
            <span className="traceIcon"><BoxIcon /></span>
            <span><small>EVENT ACCEPTED</small><strong>invoice.paid</strong></span>
            <time>12:04:31.204</time>
          </div>
          <div className="traceRail">
            <span className="traceRailDot" />
            <div><small>POSTGRES OUTBOX</small><strong>Persisted before response</strong><code>idempotency key: invoice:inv_4102</code></div>
            <span className="traceRailStatus">COMMITTED</span>
          </div>
          <div className="traceAttempt failedAttempt">
            <span className="attemptGlyph"><RetryIcon /></span>
            <span><small>ATTEMPT 01 <b>HTTP 503</b></small><strong>Receiver unavailable</strong></span>
            <code>+ 700 ms</code>
          </div>
          <div className="traceAttempt successAttempt">
            <span className="attemptGlyph"><CheckIcon /></span>
            <span><small>ATTEMPT 02 <b>HTTP 200</b></small><strong>Signature verified</strong></span>
            <code>1.12 s</code>
          </div>
          <div className="traceFooter"><span><i /> DELIVERED</span><span>HMAC-SHA256</span><span>2 ATTEMPTS</span></div>
          <div className="visualAnnotation"><span className="annotationArrow">↙</span> retries keep the original event intact</div>
        </div>
        <div className="heroIndex" aria-hidden="true">01 / DELIVERY SYSTEMS</div>
      </section>

      <section className="principleBand" aria-label="HookGuard principles">
        <span>BUILT AROUND THE HARD PARTS</span>
        <strong>Durable handoff</strong><i />
        <strong>Signed delivery</strong><i />
        <strong>Visible recovery</strong>
      </section>

      <section className="flowSection" id="flow">
        <div className="sectionIntro">
          <p className="landingKicker"><span className="kickerLine" /> FROM PRODUCER TO RECEIVER</p>
          <h2>One clear path.<br /><em>No mystery retries.</em></h2>
          <p>Accepted events move through a durable outbox before a separate worker takes over delivery. When something fails, HookGuard records what happened and when the next attempt is due.</p>
        </div>
        <div className="flowSteps">
          {steps.map((step, index) => (
            <article className="flowStepCard" key={step.number}>
              <div className="flowStepTop"><span>{step.number}</span>{index < steps.length - 1 && <div className="stepConnector"><i /></div>}</div>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </article>
          ))}
        </div>
        <div className="architectureStrip" aria-label="System architecture">
          <FlowNode label="PRODUCER" detail="MiniStore or API" icon="box" />
          <FlowConnector />
          <FlowNode label="POSTGRES" detail="Event + outbox" icon="database" />
          <FlowConnector />
          <FlowNode label="BULLMQ WORKER" detail="Retry + sign" icon="arrows" />
          <FlowConnector />
          <FlowNode label="RECEIVER" detail="Verify + dedupe" icon="shield" />
        </div>
      </section>

      <section className="capabilitySection" id="capabilities">
        <div className="capabilityHeading">
          <div>
            <p className="landingKicker"><span className="kickerLine" /> ENGINEERED FOR FAILURE</p>
            <h2>Reliability you<br />can <em>inspect.</em></h2>
          </div>
          <p>Webhooks are easy when everything is healthy. HookGuard is built to make the unhappy path understandable and recoverable.</p>
        </div>
        <div className="capabilityGrid">
          {capabilities.map((capability) => (
            <article className="capabilityCard" key={capability.code}>
              <span className="capabilityCode">{capability.code}</span>
              <div className="capabilityRule" />
              <h3>{capability.title}</h3>
              <p>{capability.copy}</p>
              <span className="capabilityArrow"><ArrowUpRight /></span>
            </article>
          ))}
        </div>
      </section>

      <section className="productSection">
        <div className="productHeading">
          <p className="landingKicker"><span className="kickerLine" /> THE OPERATIONS VIEW</p>
          <h2>See what the receiver saw.</h2>
          <p>Explore the event timeline, endpoint health, receiver inbox, and controlled failure scenarios in the HookGuard console.</p>
        </div>
        <a className="productImageLink" href="/app" aria-label="Open the HookGuard dashboard">
          <div className="productImageBar"><span><i /><i /><i /></span><code>hookguard / overview</code><span className="imageOpen">OPEN CONSOLE <ArrowUpRight /></span></div>
          <img src="/hookguard-overview.png" alt="HookGuard dashboard with delivery metrics, endpoint health, service status, and the producer to receiver flow" loading="lazy" />
        </a>
      </section>

      <footer className="landingFooter">
        <div className="footerMessage">
          <p className="landingKicker"><span className="kickerLine" /> READY TO TRACE AN EVENT?</p>
          <h2>Follow one delivery<br /><em>all the way through.</em></h2>
        </div>
        <a className="footerCta" href="/app">Launch HookGuard <ArrowRight /></a>
        <div className="footerBottom">
          <a className="landingBrand footerBrand" href="/">
            <span className="landingMark"><HookMark /></span>
            <span><strong>hookguard</strong><small>DELIVERY CONTROL PLANE</small></span>
          </a>
          <span>Built to make delivery failures visible and recoverable.</span>
          <a href="https://github.com/msnotfound/hookguard" target="_blank" rel="noreferrer">View source <ArrowUpRight /></a>
        </div>
      </footer>
    </main>
  );
}

function FlowNode({ label, detail, icon }) {
  return <div className="flowNode"><span className="flowNodeIcon">{icon === "database" ? <DatabaseIcon /> : icon === "arrows" ? <RetryIcon /> : icon === "shield" ? <ShieldIcon /> : <BoxIcon />}</span><strong>{label}</strong><small>{detail}</small></div>;
}

function FlowConnector() { return <span className="architectureConnector"><i /></span>; }

function HookMark() {
  return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M19.4 5.5c-4.1 0-6.4 2.4-6.4 6.5v7.3c0 2.1-1.2 3.3-3.1 3.3-1.8 0-3-1.2-3-3.1" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/><path d="M12.8 12.4h9.5c2.5 0 4.2 1.5 4.2 3.9s-1.7 3.9-4.2 3.9h-7.8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/><path d="m16.2 9.2-3.4 3.3 3.4 3.4" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function ArrowRight() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M3 9h11M9 4l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ArrowDown() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M9 3v11M4 9l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ArrowUpRight() { return <svg viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M5 13 13 5M6 5h7v7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function BoxIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="m4.5 7.8 7.5 4.3 7.5-4.3M12 12v8.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>; }
function DatabaseIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" stroke="currentColor" strokeWidth="1.5"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" stroke="currentColor" strokeWidth="1.5"/></svg>; }
function RetryIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.7 9A7 7 0 0 1 18 6l2 6M18.3 15A7 7 0 0 1 6 18l-2-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function CheckIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ShieldIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 20 6v5c0 5-3.2 8.3-8 10-4.8-1.7-8-5-8-10V6l8-3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="m8.5 12 2.3 2.3 4.8-4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
