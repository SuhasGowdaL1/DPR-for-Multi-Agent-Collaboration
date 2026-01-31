# DPR: Distributed Protocol for Reasoning

A comprehensive framework for **human-supervised collaborative problem-solving by multiple AI agents**. Implements structured turn-taking, fair governance, and human-in-the-loop control mechanisms.

## Project Overview

**Working Title:** "Designing a Scalable Protocol for Human-Supervised Collaborative Problem Solving by Multiple AI Agents"

**Core Goal:** Implement a structured communication and governance system enabling a human supervisor to coordinate 2–10 AI agents on shared problem-solving tasks.

### Research Questions

1. **Structured Coordination:** Does enforcing turn-taking (talking-stick protocol) improve clarity and reduce conversational interference among multiple AIs?
2. **Human Supervision:** How effectively can a human guide multi-agent reasoning using pause, redirect, and inject commands?
3. **Scalability & Stability:** How does collaborative coherence change as agents increase from 2 to 10?
4. **Governance Mechanisms:** Do hand-raise interrupts, quotas, and facilitators prevent domination, loops, and starvation?

---

## Setup Instructions

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure API Keys

Copy the example environment file:

```bash
# Windows
copy .env.example .env

# Linux/Mac
cp .env.example .env
```

Edit `.env` and configure your OpenAI API key:

```env
OPENAI_API_KEY=sk-your-actual-api-key-here
LLM_PROVIDER=openai
LLM_MODEL=gpt-3.5-turbo
TURN_LIMIT=3
AGENT_QUOTA_LIMIT=10
STARVATION_THRESHOLD=5
DEBUG_MODE=False
```

### 3. Get OpenAI API Key

1. Visit [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Sign up or log in
3. Create a new API key
4. Paste in `.env`

**⚠️ Never commit `.env` to version control** (it's in `.gitignore`)

### 4. Run the Application

```bash
python app.py
```

Access the dashboard at `http://localhost:5000`

---

## Core Features

### Phase 1: Small-Team Protocol (2–4 agents)

#### ✅ Talking-Stick Round-Robin

- Explicit token passing between agents
- Fair, sequential turn allocation
- Token holder tracked in real-time

#### ✅ Human Supervisor Commands

| Command      | Effect                                |
| ------------ | ------------------------------------- |
| **PAUSE**    | Halt protocol; human can review state |
| **RESUME**   | Restart from paused state             |
| **REDIRECT** | Direct token to specific agent        |
| **INJECT**   | Insert human guidance/context         |

#### ✅ Transparency Logging

- Conversation history with timestamps
- Ignored responses logged with reason
- Full turn-by-turn audit trail

#### ✅ Fairness & Sequencing

- Fair turn distribution metrics
- Anti-domination enforcement
- Coherence scoring

### Phase 2: Medium-Team Governance (5–10 agents)

#### ✅ Hand-Raise Interrupt Mechanism

Agents can request immediate turns when they have critical input:

```python
POST /api/hand-raise
{
  "agent": "Analyst"
}
```

#### ✅ Quota-Based Contribution Economy

- Per-agent contribution limits
- Prevents individual agent dominance
- Configurable via `AGENT_QUOTA_LIMIT`

#### ✅ Anti-Starvation Rules

- Tracks time-since-last-turn for each agent
- Auto-prioritizes agents nearing starvation
- Configurable threshold via `STARVATION_THRESHOLD`

#### ✅ Rule-Based Facilitator

- **Loop Detection:** Identifies repetitive patterns
- **Fairness Monitoring:** Ensures balanced participation
- **Auto-Redirection:** Suggests governance corrections

---

## API Endpoints

### Task Management

| Method | Endpoint    | Payload           | Purpose                 |
| ------ | ----------- | ----------------- | ----------------------- |
| `POST` | `/api/task` | `{"task": "..."}` | Set the task for agents |
| `GET`  | `/api/task` | —                 | Get current task status |

### Conversation Control

| Method | Endpoint      | Purpose                    |
| ------ | ------------- | -------------------------- |
| `GET`  | `/`           | Web UI dashboard           |
| `POST` | `/step`       | Execute next protocol step |
| `POST` | `/api/pause`  | Pause the protocol         |
| `POST` | `/api/resume` | Resume the protocol        |

### Human Guidance

| Method | Endpoint          | Payload                | Purpose                       |
| ------ | ----------------- | ---------------------- | ----------------------------- |
| `POST` | `/api/redirect`   | `{"agent": "name"}`    | Direct token to agent         |
| `POST` | `/api/inject`     | `{"guidance": "text"}` | Inject human guidance         |
| `POST` | `/api/hand-raise` | `{"agent": "name"}`    | Agent requests immediate turn |

### Monitoring & Transparency

| Method | Endpoint                 | Purpose                      |
| ------ | ------------------------ | ---------------------------- |
| `GET`  | `/api/status`            | Full protocol status         |
| `GET`  | `/api/config`            | Configuration summary        |
| `GET`  | `/api/history`           | Conversation history         |
| `GET`  | `/api/ignored-responses` | Responses not selected (why) |

### Maintenance

| Method | Endpoint     | Purpose        |
| ------ | ------------ | -------------- |
| `POST` | `/api/reset` | Reset protocol |

---

## Configuration Options

```env
# LLM Settings
OPENAI_API_KEY=sk-...              # Your OpenAI API key
LLM_PROVIDER=openai                # AI provider
LLM_MODEL=gpt-3.5-turbo            # Model selection
LLM_TEMPERATURE=0.7                # Response creativity (0-1)
LLM_MAX_TOKENS=500                 # Max response length

# DPR Protocol Settings
TURN_LIMIT=3                       # Max turns per agent per cycle
AGENT_QUOTA_LIMIT=10               # Total contributions per agent
STARVATION_THRESHOLD=5             # Turns before anti-starvation kicks in

# Application Settings
DEBUG_MODE=False                   # Enable debug logging
FLASK_PORT=5000                    # Web server port
```

---

## Usage Examples

### Example 1: Set the Task (Required First Step)

```bash
curl -X POST http://localhost:5000/api/task \
  -H "Content-Type: application/json" \
  -d '{"task": "Design a scalable microservices architecture for an e-commerce platform"}'
```

Response:

```json
{
  "status": "Task set successfully",
  "task": "Design a scalable microservices architecture for an e-commerce platform",
  "ready_for_collaboration": true
}
```

### Example 2: Start Collaboration

```bash
curl -X POST http://localhost:5000/step
```

Response:

```json
{
  "agent": "Analyst",
  "response": "Based on the context...",
  "turn": 1,
  "token_holder": "Architect",
  "metrics": {
    "fairness": 0.67,
    "total_turns": 3,
    "status": "Coherent"
  }
}
```

### Example 3: Human Guidance

```bash
curl -X POST http://localhost:5000/api/inject \
  -H "Content-Type: application/json" \
  -d '{"guidance": "Please focus on scalability implications"}'
```

### Example 4: Pausing for Review

```bash
# Pause
curl -X POST http://localhost:5000/api/pause

# Review
curl http://localhost:5000/api/history

# Resume
curl -X POST http://localhost:5000/api/resume
```

### Example 4: Handling Starvation

```bash
# If Agent A hasn't spoken in 5 turns, it gets priority
curl -X POST http://localhost:5000/step
# → Analyst gets next turn
```

---

## Metrics & Evaluation

### System Metrics

- **Fairness Score:** 1.0 = perfect distribution, 0.0 = dominated
- **Turn Distribution:** Count per agent
- **Starvation Detection:** Agents not getting turns
- **Loop Detection:** Repetitive conversation patterns
- **Response Quality:** LLM response coherence (logged)

### Research Outputs

Experiments should track:

1. **Structured vs. Unstructured:** DPR vs. free-form chat
2. **Scalability:** Behavior with 2, 4, 6, 8, 10 agents
3. **Intervention Impact:** How human commands affect stability
4. **Fairness Timeline:** Turn distribution over conversation length

---

## Project Structure

```
.
├── app.py                      # Flask web server
├── dpr_engine_v2.py            # DPR protocol engine
├── requirements.txt            # Python dependencies
├── .env.example                # Configuration template
├── .env                        # (your local config - not in repo)
├── SETUP.md                    # This file
├── templates/
│   └── index.html              # Web dashboard UI
└── README.md                   # Project overview
```

---

## Key Classes

### `DPRProtocol`

Main orchestrator - manages agents, token controller, and facilitator

### `DPRAgent`

Individual agent with LLM integration and contribution tracking

### `TokenController`

Manages talking-stick token passing

### `HandRaiseQueue`

Priority queue for agent interrupts

### `DPRFacilitator`

Governance enforcement - loop detection, fairness, anti-starvation

### `Message` & `IgnoredResponse`

Structured logging for transparency

---

## Fallback Behavior

If no OpenAI API key is configured, the framework gracefully falls back to **mock responses**:

```
Agent Analyst: "As a Data Specialist, I've analyzed the context and identified key metrics."
```

This allows local testing without API costs.

---

## Troubleshooting

| Issue                    | Solution                                           |
| ------------------------ | -------------------------------------------------- |
| "API key not configured" | Set `OPENAI_API_KEY` in `.env`                     |
| ImportError for openai   | Run `pip install openai`                           |
| Connection timeout       | Check internet; verify API key on OpenAI dashboard |
| Protocol won't resume    | Ensure you called `/api/pause` first               |
| Agents starving          | Decrease `STARVATION_THRESHOLD` in `.env`          |

---

## Future Enhancements (Phase 3+)

- **AI-Assisted Facilitator:** Machine learning-based governance
- **5-10 Agent Scaling:** Extended experiments
- **Consensus Protocols:** Voting mechanisms
- **Distributed Tokens:** Multiple simultaneous speakers
- **Persistence:** Save/load conversation state

---

## License

See LICENSE file

---

## Contact

For questions about the DPR Framework, contact your project supervisor.
