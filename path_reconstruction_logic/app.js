const steps = [
  {
    title: "1. Start from an entrypoint",
    token: "main_entry",
    caption: "An entry marker creates the first candidate path. Its stack has one explicit frame: main.",
    callers: [
      {
        path: "P0",
        cfg: ["-"],
        static: ["-"],
        result: "seed candidate",
      },
    ],
    paths: [
      {
        id: "P0",
        state: "active",
        stack: ["main"],
        feasible: [],
        edges: [],
        note: "waiting for the next runtime token",
      },
    ],
  },
  {
    title: "2. CFG finds feasible callers",
    token: "setup",
    caption: "For the token setup, the CFG says main is at a call site that can call setup. The static callgraph also has main -> setup, so the path stays alive.",
    callers: [
      {
        path: "P0",
        cfg: ["main"],
        static: ["main -> setup"],
        result: "keep main -> setup",
      },
    ],
    paths: [
      {
        id: "P0",
        state: "active",
        stack: ["main", "setup"],
        feasible: ["main"],
        edges: [["main", "setup"]],
        note: "runtime graph records main -> setup",
      },
    ],
  },
  {
    title: "3. Ambiguity branches the path",
    token: "read_config",
    caption: "Both setup and main are CFG-feasible, and both edges exist in the static callgraph. Reconstruction keeps both candidate histories.",
    callers: [
      {
        path: "P0",
        cfg: ["setup", "main"],
        static: ["setup -> read_config", "main -> read_config"],
        result: "branch into P1 and P2",
      },
    ],
    paths: [
      {
        id: "P1",
        state: "active",
        stack: ["main", "setup", "read_config"],
        feasible: ["setup"],
        edges: [["main", "setup"], ["setup", "read_config"]],
        note: "candidate says setup called read_config",
      },
      {
        id: "P2",
        state: "active",
        stack: ["main", "read_config"],
        feasible: ["main"],
        edges: [["main", "setup"], ["main", "read_config"]],
        note: "candidate says main called read_config",
      },
    ],
  },
  {
    title: "4. Inner frames block outer callers",
    token: "decrypt",
    caption: "The token decrypt appears while read_config is still active. Even if an outer frame has a matching call site, reconstruction first asks whether the active inner frame can return. Here it cannot, so read_config is the only feasible caller.",
    callers: [
      {
        path: "P1",
        cfg: ["read_config", "setup blocked by active read_config"],
        static: ["read_config -> decrypt"],
        result: "keep read_config -> decrypt",
      },
      {
        path: "P2",
        cfg: ["read_config", "main blocked by active read_config"],
        static: ["read_config -> decrypt"],
        result: "keep read_config -> decrypt",
      },
    ],
    paths: [
      {
        id: "P1",
        state: "active",
        stack: ["main", "setup", "read_config", "decrypt"],
        feasible: ["read_config"],
        edges: [["main", "setup"], ["setup", "read_config"], ["read_config", "decrypt"]],
        note: "outer setup is blocked until read_config can return",
      },
      {
        id: "P2",
        state: "active",
        stack: ["main", "read_config", "decrypt"],
        feasible: ["read_config"],
        edges: [["main", "setup"], ["main", "read_config"], ["read_config", "decrypt"]],
        note: "same token, different history, same active inner caller",
      },
    ],
  },
  {
    title: "5. Both histories still survive",
    token: "validate",
    caption: "After decrypt returns, read_config reaches its validate call site. Both candidate histories remain possible because both contain the same active read_config frame.",
    callers: [
      {
        path: "P1",
        cfg: ["read_config"],
        static: ["read_config -> validate"],
        result: "keep",
      },
      {
        path: "P2",
        cfg: ["read_config"],
        static: ["read_config -> validate"],
        result: "keep",
      },
    ],
    paths: [
      {
        id: "P1",
        state: "active",
        stack: ["main", "setup", "read_config", "validate"],
        feasible: ["read_config"],
        edges: [
          ["main", "setup"],
          ["setup", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
        ],
        note: "setup-owned read_config remains valid",
      },
      {
        id: "P2",
        state: "active",
        stack: ["main", "read_config", "validate"],
        feasible: ["read_config"],
        edges: [
          ["main", "setup"],
          ["main", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
        ],
        note: "main-owned read_config remains valid",
      },
    ],
  },
  {
    title: "6. A second ambiguity creates three paths",
    token: "audit",
    caption: "Once read_config returns, the next token audit can be attributed to setup or main in P1, while P2 can only attribute it to main. Candidate count grows again.",
    callers: [
      {
        path: "P1",
        cfg: ["setup", "main"],
        static: ["setup -> audit", "main -> audit"],
        result: "branch into P1a and P1b",
      },
      {
        path: "P2",
        cfg: ["main"],
        static: ["main -> audit"],
        result: "keep as P2a",
      },
    ],
    paths: [
      {
        id: "P1a",
        state: "active",
        stack: ["main", "setup", "audit"],
        feasible: ["setup"],
        edges: [
          ["main", "setup"],
          ["setup", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
          ["setup", "audit"],
        ],
        note: "audit belongs to setup",
      },
      {
        id: "P1b",
        state: "active",
        stack: ["main", "audit"],
        feasible: ["main"],
        edges: [
          ["main", "setup"],
          ["setup", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
          ["main", "audit"],
        ],
        note: "same earlier history, but audit belongs to main",
      },
      {
        id: "P2a",
        state: "active",
        stack: ["main", "audit"],
        feasible: ["main"],
        edges: [
          ["main", "setup"],
          ["main", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
          ["main", "audit"],
        ],
        note: "different earlier history, same current stack shape",
      },
    ],
  },
  {
    title: "7. Static callgraph removes two histories",
    token: "commit",
    caption: "After audit returns, P1a is still inside setup and can call commit. P1b and P2a are back in main; their CFG has an indirect slot, but the static callgraph has no main -> commit edge.",
    callers: [
      {
        path: "P1a",
        cfg: ["setup"],
        static: ["setup -> commit"],
        result: "keep",
      },
      {
        path: "P1b",
        cfg: ["main indirect slot"],
        static: ["no main -> commit"],
        result: "eliminate",
      },
      {
        path: "P2a",
        cfg: ["main indirect slot"],
        static: ["no main -> commit"],
        result: "eliminate",
      },
    ],
    paths: [
      {
        id: "P1a",
        state: "active",
        stack: ["main", "setup", "commit"],
        feasible: ["setup"],
        edges: [
          ["main", "setup"],
          ["setup", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
          ["setup", "audit"],
          ["setup", "commit"],
        ],
        note: "only surviving history after static filtering",
      },
      {
        id: "P1b",
        state: "eliminated",
        stack: ["main"],
        feasible: ["main"],
        edges: [
          ["main", "setup"],
          ["setup", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
          ["main", "audit"],
        ],
        note: "eliminated: static callgraph rejects main -> commit",
      },
      {
        id: "P2a",
        state: "eliminated",
        stack: ["main"],
        feasible: ["main"],
        edges: [
          ["main", "setup"],
          ["main", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
          ["main", "audit"],
        ],
        note: "eliminated: static callgraph rejects main -> commit",
      },
    ],
  },
  {
    title: "8. The surviving path continues",
    token: "flush",
    caption: "The remaining candidate receives the final token. Its top inferred frame commit has a CFG call site for flush, and the static callgraph confirms commit -> flush.",
    callers: [
      {
        path: "P1a",
        cfg: ["commit"],
        static: ["commit -> flush"],
        result: "final runtime graph",
      },
    ],
    paths: [
      {
        id: "P1a",
        state: "final",
        stack: ["main", "setup", "commit", "flush"],
        feasible: ["commit"],
        edges: [
          ["main", "setup"],
          ["setup", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
          ["setup", "audit"],
          ["setup", "commit"],
          ["commit", "flush"],
        ],
        note: "final reconstructed runtime graph",
      },
      {
        id: "P1b",
        state: "eliminated",
        stack: ["main"],
        feasible: [],
        edges: [
          ["main", "setup"],
          ["setup", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
          ["main", "audit"],
        ],
        note: "already eliminated",
      },
      {
        id: "P2a",
        state: "eliminated",
        stack: ["main"],
        feasible: [],
        edges: [
          ["main", "setup"],
          ["main", "read_config"],
          ["read_config", "decrypt"],
          ["read_config", "validate"],
          ["main", "audit"],
        ],
        note: "already eliminated",
      },
    ],
  },
];

const tokens = steps.map((step) => step.token);

const layout = {
  main: [170, 34],
  setup: [72, 92],
  read_config: [266, 92],
  decrypt: [266, 148],
  validate: [266, 210],
  audit: [72, 156],
  commit: [72, 220],
  flush: [170, 220],
};

const cfgLibrary = {
  main: [
    ["M1", "entry"],
    ["M2", "call setup"],
    ["M3", "call read_config"],
    ["M4", "call audit"],
    ["M5", "indirect call slot"],
    ["M6", "exit"],
  ],
  setup: [
    ["S1", "entry"],
    ["S2", "call read_config"],
    ["S3", "call audit"],
    ["S4", "call commit"],
    ["S5", "return"],
  ],
  read_config: [
    ["R1", "entry"],
    ["R2", "call decrypt"],
    ["R3", "call validate"],
    ["R4", "return"],
  ],
  decrypt: [
    ["D1", "entry"],
    ["D2", "return"],
  ],
  validate: [
    ["V1", "entry"],
    ["V2", "return"],
  ],
  audit: [
    ["A1", "entry"],
    ["A2", "return"],
  ],
  commit: [
    ["C1", "entry"],
    ["C2", "call flush"],
    ["C3", "return"],
  ],
  flush: [
    ["F1", "entry"],
    ["F2", "return"],
  ],
};

let index = 0;
let timer = null;
let playing = false;

const titleEl = document.getElementById("title");
const captionEl = document.getElementById("caption");
const tokensEl = document.getElementById("tokens");
const rowsEl = document.getElementById("caller-rows");
const pathsEl = document.getElementById("paths");
const countEl = document.getElementById("step-count");
const sliderEl = document.getElementById("slider");
const playEl = document.getElementById("play");

sliderEl.max = String(steps.length - 1);

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderTokens() {
  tokensEl.innerHTML = tokens
    .map((token, tokenIndex) => {
      const current = tokenIndex === index ? " current" : "";
      return `<span class="token${current}">${esc(token)}</span>`;
    })
    .join("");
}

function renderCallerRows(step) {
  rowsEl.innerHTML = step.callers
    .map((row) => {
      const eliminateClass = row.result.includes("eliminate") ? " eliminate" : "";
      return `
        <tr>
          <td><code>${esc(row.path)}</code></td>
          <td><code>${esc(row.cfg.join(", "))}</code></td>
          <td><code>${esc(row.static.join(", "))}</code></td>
          <td class="result${eliminateClass}">${esc(row.result)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCallStack(path) {
  const feasible = new Set(path.feasible || []);
  return `
    <div>
      <div class="mini-title">Call stack · green = feasible caller</div>
      <div class="call-stack">
        ${path.stack
          .map((frame, frameIndex) => {
            const classes = ["stack-frame"];
            if (frameIndex === path.stack.length - 1) classes.push("top");
            if (feasible.has(frame)) classes.push("feasible");
            return `<div class="${classes.join(" ")}">${esc(frame)}</div>`;
          })
          .join("")}
      </div>
    </div>
  `;
}

function cfgLineClass(frame, line, step, path) {
  const feasible = new Set(path.feasible || []);
  if (!feasible.has(frame)) return "";

  const token = step.token;
  const text = line.toLowerCase();

  if (token === "commit" && frame === "main" && text.includes("indirect")) {
    return " blocked";
  }
  if (text.includes(`call ${token}`)) {
    return " hot";
  }
  return "";
}

function renderCfgs(step, path) {
  const framesToShow = [...new Set(path.stack)];
  return `
    <div>
      <div class="mini-title">CFG check · highlighted site for "${esc(step.token)}"</div>
      <div class="cfg-list">
        ${framesToShow
          .map((frame) => {
            const cfg = cfgLibrary[frame] || [["?", "no CFG shown"]];
            return `
              <div class="cfg-card">
                <div class="cfg-name">${esc(frame)} CFG</div>
                <div class="cfg-lines">
                  ${cfg
                    .map(([id, line]) => {
                      const lineClass = cfgLineClass(frame, line, step, path);
                      return `
                        <div class="cfg-line${lineClass}">
                          <span class="cfg-dot">${esc(id)}</span>
                          <span>${esc(line)}</span>
                        </div>
                      `;
                    })
                    .join("")}
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function graphSvg(path) {
  if (!path.edges.length) {
    return '<div class="empty-graph">no runtime edges yet</div>';
  }

  const nodes = [...new Set(path.edges.flat())];
  const edges = path.edges
    .map(([from, to], edgeIndex) => {
      const [x1, y1] = layout[from];
      const [x2, y2] = layout[to];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const startX = x1 + (dx / len) * 27;
      const startY = y1 + (dy / len) * 20;
      const endX = x2 - (dx / len) * 34;
      const endY = y2 - (dy / len) * 21;
      return `<path class="edge" style="animation-delay:${edgeIndex * 80}ms" d="M ${startX} ${startY} L ${endX} ${endY}"></path>`;
    })
    .join("");

  const nodeMarkup = nodes
    .map((node) => {
      const [x, y] = layout[node];
      return `
        <g class="node">
          <circle cx="${x}" cy="${y}" r="26"></circle>
          <text x="${x}" y="${y}">${esc(node)}</text>
        </g>
      `;
    })
    .join("");

  return `
    <svg viewBox="0 0 340 255" role="img" aria-label="Runtime graph for ${esc(path.id)}">
      <defs>
        <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#208478"></path>
        </marker>
      </defs>
      ${edges}
      ${nodeMarkup}
    </svg>
  `;
}

function renderPaths(step) {
  pathsEl.innerHTML = step.paths
    .map((path, pathIndex) => {
      const stateClass = path.state === "active" ? "" : ` ${path.state}`;
      return `
        <article class="path-card${stateClass}" style="animation-delay:${pathIndex * 90}ms">
          <div class="path-head">
            <span class="badge${stateClass}">${esc(path.id)} · ${esc(path.state)}</span>
            <div class="note">${esc(path.note)}</div>
          </div>
          <div class="candidate-detail">
            ${renderCallStack(path)}
            ${renderCfgs(step, path)}
          </div>
          ${graphSvg(path)}
        </article>
      `;
    })
    .join("");
}

function render() {
  const step = steps[index];
  titleEl.textContent = step.title;
  captionEl.textContent = step.caption;
  countEl.textContent = `Step ${index + 1} of ${steps.length}`;
  sliderEl.value = String(index);
  renderTokens();
  renderCallerRows(step);
  renderPaths(step);
}

function setPlaying(nextPlaying) {
  playing = nextPlaying;
  playEl.textContent = playing ? "Pause" : "Play";

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  if (playing) {
    timer = setInterval(() => {
      index = (index + 1) % steps.length;
      render();
    }, 2600);
  }
}

document.getElementById("prev").addEventListener("click", () => {
  index = (index - 1 + steps.length) % steps.length;
  render();
});

document.getElementById("next").addEventListener("click", () => {
  index = (index + 1) % steps.length;
  render();
});

playEl.addEventListener("click", () => setPlaying(!playing));

sliderEl.addEventListener("input", (event) => {
  index = Number(event.target.value);
  render();
});

render();
