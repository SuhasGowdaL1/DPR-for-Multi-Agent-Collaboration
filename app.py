import os
import logging
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
from dpr_engine import DPRProtocol, CommandType

# Load environment variables
load_dotenv()
# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Initialize DPR Protocol
try:
    agent_names = ["Analyst", "Architect", "Reviewer"]
    agent_roles = ["Data Specialist", "System Designer", "Quality Control"]
    turn_limit = int(os.getenv("TURN_LIMIT", 3))

    dpr_protocol = DPRProtocol(agent_names, agent_roles, turn_limit=turn_limit)
    dpr_protocol.start()

    logger.info(
        f"DPR Protocol initialized with {len(agent_names)} agents, turn_limit={turn_limit}"
    )

    # User-provided task (initially empty, set via /api/task endpoint)
    user_task = None
except Exception as e:
    logger.error(f"Failed to initialize DPR Protocol: {e}")
    dpr_protocol = None
    user_task = None


@app.route("/")
def index():
    """Serve main dashboard."""
    if dpr_protocol is None:
        return "DPR Protocol not initialized", 500
    return render_template("index.html", agents=[a.name for a in dpr_protocol.agents])


@app.route("/api/config", methods=["GET"])
def get_config():
    """Return API configuration status."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    return jsonify(
        {
            "llm_provider": os.getenv("LLM_PROVIDER", "openai"),
            "model": os.getenv("LLM_MODEL", "gpt-3.5-turbo"),
            "turn_limit": int(os.getenv("TURN_LIMIT", 3)),
            "debug_mode": os.getenv("DEBUG_MODE", "False").lower() == "true",
            "api_key_configured": bool(
                os.getenv("OPENAI_API_KEY")
                and os.getenv("OPENAI_API_KEY") != "your_openai_api_key_here"
            ),
        }
    )


@app.route("/api/status", methods=["GET"])
def get_status():
    """Get full protocol status."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    status = dpr_protocol.get_status()
    status["current_task"] = user_task
    return jsonify(status)


@app.route("/api/task", methods=["POST"])
def set_task():
    """Set the user-provided task for agents to collaborate on."""
    global user_task

    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    data = request.json
    task = data.get("task")

    if not task or not task.strip():
        return jsonify({"error": "task field required and cannot be empty"}), 400

    user_task = task.strip()

    # Inject task as initial message in conversation
    dpr_protocol.inject_guidance(f"TASK: {user_task}")

    logger.info(f"User set task: {user_task}")

    return jsonify(
        {
            "status": "Task set successfully",
            "task": user_task,
            "ready_for_collaboration": True,
        }
    )


@app.route("/api/task", methods=["GET"])
def get_task():
    """Get current task."""
    return jsonify({"task": user_task, "task_set": user_task is not None})


@app.route("/step", methods=["POST"])
def step():
    """Execute one protocol step."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    if user_task is None:
        return (
            jsonify({"error": "No task set. Call POST /api/task with a task first."}),
            400,
        )

    result = dpr_protocol.execute_step()

    # If facilitator returned an error, forward it
    if isinstance(result, dict) and "error" in result:
        return jsonify(result)

    # Normalize to UI-friendly shape (agent response + metrics)
    entry = {"agent": result.get("agent"), "text": result.get("response")}
    metrics = result.get("metrics")
    token_holder = result.get("token_holder")

    return jsonify(
        {
            "entry": entry,
            "metrics": metrics,
            "token_holder": token_holder,
            "system_state": result.get("system_state"),
        }
    )


@app.route("/api/pause", methods=["POST"])
def pause():
    """Pause the protocol."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    dpr_protocol.pause()
    return jsonify(
        {"status": "Protocol paused", "state": dpr_protocol.system_state.value}
    )


@app.route("/api/resume", methods=["POST"])
def resume():
    """Resume the protocol."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    dpr_protocol.resume()
    return jsonify(
        {"status": "Protocol resumed", "state": dpr_protocol.system_state.value}
    )


@app.route("/api/redirect", methods=["POST"])
def redirect():
    """Redirect token to specific agent."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    data = request.json
    target_agent = data.get("agent")

    if not target_agent:
        return jsonify({"error": "agent field required"}), 400

    success = dpr_protocol.redirect(target_agent)
    if success:
        return jsonify({"status": f"Token redirected to {target_agent}"})
    else:
        return jsonify({"error": f"Agent {target_agent} not found"}), 404


@app.route("/api/hand-raise", methods=["POST"])
def hand_raise():
    """Agent requests immediate turn."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    data = request.json
    agent = data.get("agent")

    if not agent:
        return jsonify({"error": "agent field required"}), 400

    success = dpr_protocol.hand_raise(agent)
    if success:
        return jsonify({"status": f"{agent} hand-raise queued"})
    else:
        return jsonify({"error": f"Agent {agent} not found"}), 404


@app.route("/api/inject", methods=["POST"])
def inject():
    """Inject human guidance."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    data = request.json
    guidance = data.get("guidance")

    if not guidance:
        return jsonify({"error": "guidance field required"}), 400

    dpr_protocol.inject_guidance(guidance)
    return jsonify({"status": "Guidance injected", "guidance": guidance})


@app.route("/api/history", methods=["GET"])
def get_history():
    """Get conversation history."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    history = [
        {
            "agent": msg.agent_name,
            "content": msg.content,
            "turn": msg.turn_number,
            "timestamp": msg.timestamp.isoformat(),
        }
        for msg in dpr_protocol.facilitator.conversation_history
    ]

    return jsonify({"history": history, "total_messages": len(history)})


@app.route("/api/ignored-responses", methods=["GET"])
def get_ignored_responses():
    """Get ignored responses for transparency."""
    if dpr_protocol is None:
        return jsonify({"error": "DPR Protocol not initialized"}), 500

    ignored = [
        {
            "agent": resp.agent_name,
            "content": resp.content,
            "turn": resp.turn_number,
            "reason": resp.reason,
            "timestamp": resp.timestamp.isoformat(),
        }
        for resp in dpr_protocol.facilitator.ignored_responses
    ]

    return jsonify({"ignored_responses": ignored, "total_ignored": len(ignored)})


@app.route("/api/reset", methods=["POST"])
def reset():
    """Reset the protocol."""
    global dpr_protocol

    try:
        agent_names = ["Analyst", "Architect", "Reviewer"]
        agent_roles = ["Data Specialist", "System Designer", "Quality Control"]
        turn_limit = int(os.getenv("TURN_LIMIT", 3))

        dpr_protocol = DPRProtocol(agent_names, agent_roles, turn_limit=turn_limit)
        dpr_protocol.start()

        logger.info("DPR Protocol reset")
        return jsonify({"status": "Protocol reset successfully"})
    except Exception as e:
        logger.error(f"Failed to reset DPR Protocol: {e}")
        return jsonify({"error": str(e)}), 500


@app.errorhandler(404)
def not_found(error):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(500)
def server_error(error):
    logger.error(f"Server error: {error}")
    return jsonify({"error": "Internal server error"}), 500


if __name__ == "__main__":
    debug_mode = os.getenv("DEBUG_MODE", "False").lower() == "true"
    app.run(debug=debug_mode, host="0.0.0.0", port=5000)
