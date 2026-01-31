import os
import logging
from typing import Optional, List, Dict, Any
from enum import Enum
from dataclasses import dataclass, field
from datetime import datetime
from collections import deque
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class CommandType(Enum):
    """Supervisor commands for human-in-the-loop guidance."""

    PAUSE = "PAUSE"
    RESUME = "RESUME"
    REDIRECT = "REDIRECT"
    INJECT = "INJECT"


class SystemState(Enum):
    """System operational states."""

    IDLE = "IDLE"
    RUNNING = "RUNNING"
    PAUSED = "PAUSED"
    LOOP_DETECTED = "LOOP_DETECTED"


@dataclass
class Message:
    """Structured message in the DPR protocol."""

    agent_name: str
    content: str
    turn_number: int
    timestamp: datetime = field(default_factory=datetime.now)
    is_response: bool = True


@dataclass
class IgnoredResponse:
    """Track responses that weren't selected."""

    agent_name: str
    content: str
    turn_number: int
    reason: str
    timestamp: datetime = field(default_factory=datetime.now)


class TokenController:
    """Manages the talking-stick token with round-robin scheduling."""

    def __init__(self, agent_names: List[str]):
        self.agent_names = agent_names
        self.current_index = 0
        self.token_holder = agent_names[0] if agent_names else None
        self.token_passes = 0

    def pass_token(self) -> str:
        """Pass token to next agent in round-robin fashion."""
        if not self.agent_names:
            return None

        self.current_index = (self.current_index + 1) % len(self.agent_names)
        self.token_holder = self.agent_names[self.current_index]
        self.token_passes += 1
        return self.token_holder

    def get_token_holder(self) -> str:
        """Get current token holder."""
        return self.token_holder

    def reset(self):
        """Reset token to first agent."""
        self.current_index = 0
        self.token_holder = self.agent_names[0] if self.agent_names else None


class HandRaiseQueue:
    """Manages agent hand-raises for interrupt mechanism."""

    def __init__(self):
        self.queue = deque()
        self.raised_agents = set()

    def add_raise(self, agent_name: str):
        """Add agent to hand-raise queue."""
        if agent_name not in self.raised_agents:
            self.queue.append(agent_name)
            self.raised_agents.add(agent_name)
            logger.info(f"Hand-raise: {agent_name} queued")

    def pop_raise(self) -> Optional[str]:
        """Remove and return next hand-raise."""
        if self.queue:
            agent = self.queue.popleft()
            self.raised_agents.discard(agent)
            return agent
        return None

    def clear(self):
        """Clear all hand-raises."""
        self.queue.clear()
        self.raised_agents.clear()

    def has_raises(self) -> bool:
        """Check if there are pending hand-raises."""
        return len(self.queue) > 0


class DPRAgent:
    """Enhanced agent with LLM integration and quotas."""

    def __init__(self, name: str, role: str):
        self.name = name
        self.role = role
        self.turn_count = 0
        self.total_contributions = 0
        self.last_turn_number = -1
        self.quota_limit = int(os.getenv("AGENT_QUOTA_LIMIT", 10))
        self.llm_provider = os.getenv("LLM_PROVIDER", "gemini").lower()
        self._validate_api_keys()

    def _validate_api_keys(self):
        """Validate that required API keys are configured."""
        if self.llm_provider == "gemini":
            api_key = os.getenv("GEMINI_API_KEY")
            if not api_key or api_key == "your_gemini_api_key_here":
                logger.warning(
                    f"Agent {self.name}: Gemini API key not configured. Using mock responses."
                )
                self.use_mock_responses = True
            else:
                self.use_mock_responses = False
        elif self.llm_provider == "openai":
            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key or api_key == "your_openai_api_key_here":
                logger.warning(
                    f"Agent {self.name}: OpenAI API key not configured. Using mock responses."
                )
                self.use_mock_responses = True
            else:
                self.use_mock_responses = False
        else:
            logger.warning(f"Unknown LLM provider: {self.llm_provider}")
            self.use_mock_responses = True

    def has_quota(self) -> bool:
        """Check if agent hasn't exceeded contribution quota."""
        return self.total_contributions < self.quota_limit

    def generate_response(self, context: str) -> str:
        """Generate agent response."""
        self.turn_count += 1
        self.total_contributions += 1

        if self.use_mock_responses:
            return self._generate_mock_response(context)

        try:
            return self._call_llm_api(context)
        except Exception as e:
            logger.error(f"LLM API error: {e}. Falling back to mock response.")
            return self._generate_mock_response(context)

    def _call_llm_api(self, context: str) -> str:
        """Call LLM API to generate response using Gemini or OpenAI."""
        model = os.getenv("LLM_MODEL", "gemini-1.5-pro")
        temperature = float(os.getenv("LLM_TEMPERATURE", 0.7))
        max_tokens = int(os.getenv("LLM_MAX_TOKENS", 500))

        prompt = f"""You are a {self.role} in a multi-agent collaboration system.

Agent Name: {self.name}
Role: {self.role}

Based on the following context, provide expert feedback as the {self.role}:
Context: {context[-200:]}

Provide a concise, professional response."""

        # Try Gemini API first
        if self.llm_provider == "gemini":
            try:
                import google.genai as genai

                api_key = os.getenv("GEMINI_API_KEY")
                if api_key:
                    # Use new google.genai API
                    genai.api_key = api_key
                    client = genai.Client()

                    response = client.models.generate_content(
                        model=model,
                        contents=prompt,
                        config=genai.types.GenerateContentConfig(
                            temperature=temperature,
                            max_output_tokens=max_tokens,
                        ),
                    )

                    if response and response.text:
                        return f"{self.name} ({self.role}): {response.text.strip()}"
            except ImportError:
                logger.error(
                    "google-genai not installed. Install with: pip install google-genai"
                )
            except Exception as e:
                logger.error(f"Gemini API error: {e}. Trying fallback...")

        # Try OpenAI as fallback
        if self.llm_provider == "openai" or self.llm_provider != "gemini":
            try:
                import openai

                api_key = os.getenv("OPENAI_API_KEY")
                openai_model = os.getenv("LLM_MODEL", "gpt-3.5-turbo")

                # Prefer new OpenAI client (openai>=1.0.0) if available
                try:
                    if hasattr(openai, "OpenAI"):
                        client = (
                            openai.OpenAI(api_key=api_key)
                            if api_key
                            else openai.OpenAI()
                        )
                        resp = client.chat.completions.create(
                            model=openai_model,
                            messages=[{"role": "user", "content": prompt}],
                            temperature=temperature,
                            max_tokens=max_tokens,
                        )

                        # Robustly extract content
                        if hasattr(resp, "choices") and len(resp.choices) > 0:
                            choice = resp.choices[0]
                            msg = getattr(choice, "message", None)
                            if isinstance(msg, dict):
                                content = msg.get("content")
                            elif msg is not None:
                                content = getattr(msg, "content", None)
                            else:
                                content = getattr(choice, "text", None)

                            if content:
                                return (
                                    f"{self.name} ({self.role}): {str(content).strip()}"
                                )
                except Exception as new_err:
                    logger.debug(f"New OpenAI client path failed: {new_err}")

                # Legacy (pre-1.0.0) OpenAI usage
                try:
                    openai.api_key = api_key
                    response = openai.ChatCompletion.create(
                        model=openai_model,
                        messages=[{"role": "user", "content": prompt}],
                        temperature=temperature,
                        max_tokens=max_tokens,
                    )
                    return response["choices"][0]["message"]["content"].strip()
                except AttributeError:
                    logger.error("Legacy OpenAI API not available in openai>=1.0.0")
            except ImportError:
                logger.error("openai not installed. Install with: pip install openai")
            except Exception as e:
                logger.error(f"OpenAI API error: {e}")

        # If all LLM calls fail, use mock response
        return self._generate_mock_response(context)

    def _generate_mock_response(self, context: str) -> str:
        """Generate mock response when API is unavailable."""
        mock_responses = {
            "Analyst": f"As a Data Specialist, I've analyzed the context and identified key metrics.",
            "Architect": f"From a System Design perspective, this requires architectural consideration.",
            "Reviewer": f"Quality Control assessment shows important compliance requirements.",
        }
        return mock_responses.get(self.name, "Reviewing context...")

    def reset_turn_count(self):
        """Reset turn count (used by human guidance)."""
        self.turn_count = 0


class DPRFacilitator:
    """Rule-based facilitator for loop detection and governance."""

    def __init__(
        self, agents: List[DPRAgent], turn_limit: int = 3, starvation_threshold: int = 5
    ):
        self.agents = agents
        self.turn_limit = turn_limit
        self.starvation_threshold = starvation_threshold
        self.conversation_history = []
        self.ignored_responses = []
        self.turn_counter = 0

    def detect_loop(self) -> bool:
        """Detect if agents are in a repetitive pattern."""
        if len(self.conversation_history) < 6:
            return False

        # Check if last 3 turns are similar patterns
        recent = self.conversation_history[-3:]
        if len(set(m.agent_name for m in recent)) == 1:
            logger.warning("Potential loop detected: Same agent dominating")
            return True

        return False

    def detect_starvation(self) -> Optional[str]:
        """Detect if any agent hasn't had a turn recently."""
        if self.turn_counter < self.starvation_threshold:
            return None

        # Check if any agent's last turn is too old
        for agent in self.agents:
            turns_since_last = self.turn_counter - agent.last_turn_number
            if turns_since_last > self.starvation_threshold:
                logger.warning(
                    f"Starvation detected: {agent.name} hasn't had turn in {turns_since_last} turns"
                )
                return agent.name

        return None

    def select_next_agent(
        self, last_agent_name: Optional[str], hand_raise_queue: HandRaiseQueue
    ) -> Optional[str]:
        """Select next agent with anti-starvation and hand-raise logic."""

        # Priority 1: Hand-raises get immediate attention
        if hand_raise_queue.has_raises():
            return hand_raise_queue.pop_raise()

        # Priority 2: Check for starvation (agent who hasn't spoken in longest)
        starving_agent = self.detect_starvation()
        if starving_agent:
            agent = next((a for a in self.agents if a.name == starving_agent), None)
            if agent and agent.has_quota():
                return agent.name

        # Priority 3: Fair rotation - skip last agent, pick lowest turn_count with quota
        eligible = [
            a
            for a in self.agents
            if a.name != last_agent_name
            and a.turn_count < self.turn_limit
            and a.has_quota()
        ]

        if not eligible:
            return None

        return min(eligible, key=lambda x: x.turn_count).name

    def record_message(self, message: Message):
        """Record message in conversation history."""
        self.conversation_history.append(message)

        # Update agent's last turn number
        for agent in self.agents:
            if agent.name == message.agent_name:
                agent.last_turn_number = self.turn_counter
                break

        self.turn_counter += 1

    def record_ignored_response(self, agent_name: str, content: str, reason: str):
        """Log ignored responses for transparency."""
        ignored = IgnoredResponse(
            agent_name=agent_name,
            content=content,
            turn_number=self.turn_counter,
            reason=reason,
        )
        self.ignored_responses.append(ignored)
        logger.info(f"Ignored response from {agent_name}: {reason}")

    def get_metrics(self) -> Dict[str, Any]:
        """Calculate fairness, stability, and coherence metrics."""
        if not self.agents:
            return {}

        counts = [a.turn_count for a in self.agents]
        total_turns = sum(counts)

        if total_turns == 0:
            return {
                "fairness": 0,
                "total_turns": 0,
                "status": "Stable",
                "loop_detected": False,
                "starvation_threat": None,
            }

        # Fairness: 1.0 is perfectly distributed
        spread = max(counts) - min(counts) if counts else 0
        fairness = max(0, 1 - (spread / total_turns))

        loop_threat = self.detect_loop()
        starvation_threat = self.detect_starvation()

        status = "Coherent"
        if loop_threat:
            status = "Loop Detected"
        elif starvation_threat:
            status = "Starvation Risk"
        elif fairness < 0.5:
            status = "Needs Oversight"

        return {
            "fairness": round(fairness, 2),
            "total_turns": total_turns,
            "turn_distribution": {a.name: a.turn_count for a in self.agents},
            "contributions": {a.name: a.total_contributions for a in self.agents},
            "status": status,
            "loop_detected": loop_threat,
            "starvation_threat": starvation_threat,
            "ignored_count": len(self.ignored_responses),
            "token_holder": getattr(self, "_token_holder", None),
        }


class DPRProtocol:
    """Main DPR protocol orchestrator."""

    def __init__(
        self, agent_names: List[str], agent_roles: List[str], turn_limit: int = 3
    ):
        self.agents = [
            DPRAgent(name, role) for name, role in zip(agent_names, agent_roles)
        ]
        self.token_controller = TokenController(agent_names)
        self.hand_raise_queue = HandRaiseQueue()
        self.facilitator = DPRFacilitator(self.agents, turn_limit=turn_limit)
        self.system_state = SystemState.IDLE
        self.paused_at_turn = None
        logger.info(f"DPR Protocol initialized with agents: {agent_names}")

    def start(self):
        """Start the protocol."""
        self.system_state = SystemState.RUNNING
        logger.info("DPR Protocol started")

    def pause(self):
        """Pause the protocol."""
        self.system_state = SystemState.PAUSED
        self.paused_at_turn = self.facilitator.turn_counter
        logger.info(f"DPR Protocol paused at turn {self.paused_at_turn}")

    def resume(self):
        """Resume the protocol."""
        self.system_state = SystemState.RUNNING
        logger.info(f"DPR Protocol resumed from turn {self.paused_at_turn}")

    def redirect(self, target_agent_name: str):
        """Redirect token to specific agent."""
        if any(a.name == target_agent_name for a in self.agents):
            self.token_controller.token_holder = target_agent_name
            logger.info(f"Token redirected to {target_agent_name}")
            return True
        return False

    def inject_guidance(self, guidance: str):
        """Inject human guidance."""
        msg = Message(
            agent_name="HUMAN_FACILITATOR",
            content=f"GUIDANCE: {guidance}",
            turn_number=self.facilitator.turn_counter,
        )
        self.facilitator.record_message(msg)
        logger.info(f"Human guidance injected: {guidance}")

    def hand_raise(self, agent_name: str):
        """Agent requests immediate turn."""
        if any(a.name == agent_name for a in self.agents):
            self.hand_raise_queue.add_raise(agent_name)
            return True
        return False

    def execute_step(self) -> Dict[str, Any]:
        """Execute one step of the protocol."""
        if self.system_state == SystemState.PAUSED:
            return {"error": "Protocol is paused"}

        last_agent = (
            self.facilitator.conversation_history[-1].agent_name
            if self.facilitator.conversation_history
            else None
        )

        # Select next agent using facilitator logic
        next_agent_name = self.facilitator.select_next_agent(
            last_agent, self.hand_raise_queue
        )

        if next_agent_name is None:
            self.system_state = SystemState.LOOP_DETECTED
            return {"error": "Governance limit reached. Human guidance required."}

        # Get agent and generate response
        agent = next(a for a in self.agents if a.name == next_agent_name)
        context = (
            self.facilitator.conversation_history[-1].content
            if self.facilitator.conversation_history
            else "Initial problem"
        )

        response = agent.generate_response(context)

        # Record message
        msg = Message(
            agent_name=agent.name,
            content=response,
            turn_number=self.facilitator.turn_counter,
        )
        self.facilitator.record_message(msg)

        # Check for loops after message
        if self.facilitator.detect_loop():
            self.system_state = SystemState.LOOP_DETECTED

        return {
            "agent": agent.name,
            "response": response,
            "turn": self.facilitator.turn_counter - 1,
            "token_holder": self.token_controller.get_token_holder(),
            "metrics": self.facilitator.get_metrics(),
            "system_state": self.system_state.value,
        }

    def get_status(self) -> Dict[str, Any]:
        """Get current protocol status."""
        return {
            "system_state": self.system_state.value,
            "turn_count": self.facilitator.turn_counter,
            "token_holder": self.token_controller.get_token_holder(),
            "hand_raises_pending": len(self.hand_raise_queue.queue),
            "metrics": self.facilitator.get_metrics(),
            "agents": [
                {
                    "name": a.name,
                    "role": a.role,
                    "turns": a.turn_count,
                    "contributions": a.total_contributions,
                    "quota_limit": a.quota_limit,
                    "has_quota": a.has_quota(),
                }
                for a in self.agents
            ],
        }
