import { useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileUp, Loader2, Play, Plus, Server, Settings2, Terminal, Trash2, XCircle } from 'lucide-react';
import './styles.css';

const apiBase = import.meta.env.VITE_API_BASE ?? '';

function compactLines(value) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function ChipInput({ label, values, onChange, placeholder }) {
  const [draft, setDraft] = useState('');

  function addValue() {
    const next = draft.trim();
    if (!next) return;
    onChange([...values, next]);
    setDraft('');
  }

  function removeValue(index) {
    onChange(values.filter((_, itemIndex) => itemIndex !== index));
  }

  return (
    <label className="field">
      <span>{label}</span>
      <div className="chipBox">
        {values.map((value, index) => (
          <button className="chip" key={`${value}-${index}`} type="button" onClick={() => removeValue(index)} title={`Remove ${value}`}>
            {value}
            <Trash2 size={13} />
          </button>
        ))}
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addValue();
            }
          }}
        />
        <button className="iconButton" type="button" onClick={addValue} title={`Add ${label}`}>
          <Plus size={16} />
        </button>
      </div>
    </label>
  );
}

function Toggle({ checked, label, onChange }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span />
      {label}
    </label>
  );
}

function labelForArtifact(name, href) {
  if (name === 'timelineHtml') return 'Runtime timeline';
  if (name === 'contextTreeHtml') return 'Context tree';
  if (name === 'runLog') return 'Run log';
  if (href.endsWith('.html')) {
    return name.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function artifactHref(href) {
  return href.startsWith('/api') ? `${apiBase}${href}` : href;
}

function App() {
  const fileInputRef = useRef(null);
  const entrypointsFileInputRef = useRef(null);
  const [logText, setLogText] = useState('');
  const [logName, setLogName] = useState('');
  const [entrypoints, setEntrypoints] = useState('main');
  const [entrypointsName, setEntrypointsName] = useState('');
  const [sourceRootsText, setSourceRootsText] = useState('examples');
  const [includeDirs, setIncludeDirs] = useState(['.']);
  const [compileFlags, setCompileFlags] = useState(['-I.']);
  const [cfgArgs, setCfgArgs] = useState([]);
  const [callgraphArgs, setCallgraphArgs] = useState([]);
  const [runtimeArgs, setRuntimeArgs] = useState([]);
  const [contextDepth, setContextDepth] = useState(3);
  const [topK, setTopK] = useState(8);
  const [lookahead, setLookahead] = useState(8);
  const [emitDot, setEmitDot] = useState(true);
  const [emitHtml, setEmitHtml] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  const sourceRoots = useMemo(() => compactLines(sourceRootsText), [sourceRootsText]);
  const canRun = logText.trim() && entrypoints.trim() && sourceRoots.length > 0 && !running;

  async function readLogFile(file) {
    if (!file) return;
    setLogName(file.name);
    setLogText(await file.text());
  }

  async function readEntrypointsFile(file) {
    if (!file) return;
    setEntrypointsName(file.name);
    setEntrypoints(await file.text());
  }

  async function runAnalysis() {
    if (!canRun) return;
    setRunning(true);
    setError('');
    setResult(null);

    const payload = {
      runtimeLog: logText,
      entrypoints,
      sourceRoots,
      includeDirs,
      compileFlags,
      contextDepth,
      topK,
      lookaheadPlainEvents: lookahead,
      emitDot,
      emitHtml,
      executableArgs: {
        cfg: cfgArgs,
        callgraph: callgraphArgs,
        runtime: runtimeArgs
      }
    };

    try {
      const response = await fetch(`${apiBase}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        setError(json.error || 'Analysis failed');
      }
      setResult(json);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setRunning(false);
    }
  }

  const artifactLinks = result?.artifacts ? Object.entries(result.artifacts) : [];
  const htmlArtifacts = artifactLinks.filter(([, href]) => href.endsWith('.html'));
  const downloadArtifacts = artifactLinks.filter(([, href]) => !href.endsWith('.html'));

  return (
    <main className="app">
      <header className="topBar">
        <div>
          <p className="eyebrow">CFG Runtime Lab</p>
          <h1>Runtime Log Workbench</h1>
        </div>
        <div className="statusPill">
          <Server size={16} />
          uWebSockets API
        </div>
      </header>

      <section className="workspace">
        <div className="panel uploadPanel">
          <div className="panelHeader">
            <FileUp size={18} />
            <h2>Runtime Log</h2>
          </div>

          <button
            className="dropZone"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              readLogFile(event.dataTransfer.files?.[0]);
            }}
          >
            <FileUp size={24} />
            <strong>{logName || 'Select log file'}</strong>
            <span>{logText ? `${logText.length.toLocaleString()} bytes loaded` : 'Drop runtime log here'}</span>
          </button>
          <input ref={fileInputRef} className="hiddenInput" type="file" onChange={(event) => readLogFile(event.target.files?.[0])} />

          <label className="field grow">
            <span>Log preview</span>
            <textarea value={logText} onChange={(event) => setLogText(event.target.value)} spellCheck="false" />
          </label>

          <label className="field short">
            <span>Entrypoints</span>
            <textarea value={entrypoints} onChange={(event) => setEntrypoints(event.target.value)} spellCheck="false" />
          </label>

          <button
            className="ghostButton"
            type="button"
            onClick={() => entrypointsFileInputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              readEntrypointsFile(event.dataTransfer.files?.[0]);
            }}
          >
            <FileUp size={16} />
            {entrypointsName || 'Select entrypoints file'}
          </button>
          <input
            ref={entrypointsFileInputRef}
            className="hiddenInput"
            type="file"
            onChange={(event) => readEntrypointsFile(event.target.files?.[0])}
          />
        </div>

        <div className="panel settingsPanel">
          <div className="panelHeader">
            <Settings2 size={18} />
            <h2>Build Inputs</h2>
          </div>

          <label className="field">
            <span>Source roots</span>
            <textarea className="mediumText" value={sourceRootsText} onChange={(event) => setSourceRootsText(event.target.value)} spellCheck="false" />
          </label>

          <ChipInput label="Include dirs" values={includeDirs} onChange={setIncludeDirs} placeholder="include" />
          <ChipInput label="Compilation flags" values={compileFlags} onChange={setCompileFlags} placeholder="-DFEATURE=1" />

          <div className="numberGrid">
            <label className="field">
              <span>Context depth</span>
              <input type="number" min="1" max="12" value={contextDepth} onChange={(event) => setContextDepth(Number(event.target.value))} />
            </label>
            <label className="field">
              <span>Top K</span>
              <input type="number" min="1" max="64" value={topK} onChange={(event) => setTopK(Number(event.target.value))} />
            </label>
            <label className="field">
              <span>Lookahead</span>
              <input type="number" min="0" max="64" value={lookahead} onChange={(event) => setLookahead(Number(event.target.value))} />
            </label>
          </div>

          <div className="toggles">
            <Toggle checked={emitDot} label="DOT output" onChange={setEmitDot} />
            <Toggle checked={emitHtml} label="HTML reports" onChange={setEmitHtml} />
          </div>

          <div className="panelHeader compact">
            <Terminal size={17} />
            <h2>Executable Args</h2>
          </div>
          <ChipInput label="cfg_generator" values={cfgArgs} onChange={setCfgArgs} placeholder="--emit-dot" />
          <ChipInput label="callgraph_generator" values={callgraphArgs} onChange={setCallgraphArgs} placeholder="--debug" />
          <ChipInput label="runtime_callgraph_generator" values={runtimeArgs} onChange={setRuntimeArgs} placeholder="--no-html" />
        </div>

        <div className="panel runPanel">
          <div className="panelHeader">
            <Play size={18} />
            <h2>Run</h2>
          </div>

          <button className="runButton" type="button" disabled={!canRun} onClick={runAnalysis}>
            {running ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            {running ? 'Running analysis' : 'Run analysis'}
          </button>

          {error && (
            <div className="notice error">
              <XCircle size={18} />
              {error}
            </div>
          )}

          {result && (
            <div className={`notice ${result.ok ? 'success' : 'error'}`}>
              {result.ok ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              <span>
                Job {result.jobId} finished in {result.durationMs} ms
              </span>
            </div>
          )}

          {htmlArtifacts.length > 0 && (
            <>
              <div className="panelHeader compact">
                <FileUp size={17} />
                <h2>HTML pages</h2>
              </div>
              <div className="pageGrid">
                {htmlArtifacts.map(([name, href]) => (
                  <a key={name} href={artifactHref(href)} target="_blank" rel="noreferrer">
                    {labelForArtifact(name, href)}
                  </a>
                ))}
              </div>
            </>
          )}

          {downloadArtifacts.length > 0 && (
            <>
              <div className="panelHeader compact">
                <FileUp size={17} />
                <h2>Downloads</h2>
              </div>
              <div className="artifactGrid">
                {downloadArtifacts.map(([name, href]) => (
                  <a key={name} href={artifactHref(href)} target="_blank" rel="noreferrer">
                    {labelForArtifact(name, href)}
                  </a>
                ))}
              </div>
            </>
          )}

          <label className="field consoleField">
            <span>Console</span>
            <pre>{result?.log || 'Waiting for a run.'}</pre>
          </label>
        </div>
      </section>
    </main>
  );
}

export default App;
