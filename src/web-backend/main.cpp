#if __has_include(<uwebsockets/App.h>)
#include <uwebsockets/App.h>
#else
#include <App.h>
#endif

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <poll.h>
#include <sstream>
#include <stdexcept>
#include <string.h>
#include <string>
#include <string_view>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <variant>
#include <vector>

namespace fs = std::filesystem;

namespace
{

  struct Json
  {
    using Array = std::vector<Json>;
    using Object = std::map<std::string, Json>;

    std::variant<std::nullptr_t, bool, double, std::string, Array, Object> value;

    Json() : value(nullptr) {}
    explicit Json(bool v) : value(v) {}
    explicit Json(double v) : value(v) {}
    explicit Json(std::string v) : value(std::move(v)) {}
    explicit Json(Array v) : value(std::move(v)) {}
    explicit Json(Object v) : value(std::move(v)) {}

    bool isObject() const { return std::holds_alternative<Object>(value); }
    bool isArray() const { return std::holds_alternative<Array>(value); }
    const Object &object() const { return std::get<Object>(value); }
    const Array &array() const { return std::get<Array>(value); }
  };

  class JsonParser
  {
  public:
    explicit JsonParser(std::string_view input) : input_(input) {}

    Json parse()
    {
      skipWhitespace();
      Json value = parseValue();
      skipWhitespace();
      if (pos_ != input_.size())
      {
        throw std::runtime_error("unexpected trailing JSON input");
      }
      return value;
    }

  private:
    std::string_view input_;
    size_t pos_ = 0;

    void skipWhitespace()
    {
      while (pos_ < input_.size() &&
             std::isspace(static_cast<unsigned char>(input_[pos_])))
      {
        ++pos_;
      }
    }

    bool consume(char expected)
    {
      skipWhitespace();
      if (pos_ >= input_.size() || input_[pos_] != expected)
      {
        return false;
      }
      ++pos_;
      return true;
    }

    void expect(char expected)
    {
      if (!consume(expected))
      {
        throw std::runtime_error("invalid JSON syntax");
      }
    }

    Json parseValue()
    {
      skipWhitespace();
      if (pos_ >= input_.size())
      {
        throw std::runtime_error("empty JSON value");
      }

      const char c = input_[pos_];
      if (c == '"')
      {
        return Json(parseString());
      }
      if (c == '{')
      {
        return parseObject();
      }
      if (c == '[')
      {
        return parseArray();
      }
      if (c == 't' && input_.substr(pos_, 4) == "true")
      {
        pos_ += 4;
        return Json(true);
      }
      if (c == 'f' && input_.substr(pos_, 5) == "false")
      {
        pos_ += 5;
        return Json(false);
      }
      if (c == 'n' && input_.substr(pos_, 4) == "null")
      {
        pos_ += 4;
        return Json();
      }
      if (c == '-' || std::isdigit(static_cast<unsigned char>(c)))
      {
        return Json(parseNumber());
      }
      throw std::runtime_error("invalid JSON value");
    }

    Json parseObject()
    {
      expect('{');
      Json::Object object;
      skipWhitespace();
      if (consume('}'))
      {
        return Json(std::move(object));
      }
      while (true)
      {
        skipWhitespace();
        if (pos_ >= input_.size() || input_[pos_] != '"')
        {
          throw std::runtime_error("object keys must be strings");
        }
        std::string key = parseString();
        expect(':');
        object.emplace(std::move(key), parseValue());
        if (consume('}'))
        {
          break;
        }
        expect(',');
      }
      return Json(std::move(object));
    }

    Json parseArray()
    {
      expect('[');
      Json::Array array;
      skipWhitespace();
      if (consume(']'))
      {
        return Json(std::move(array));
      }
      while (true)
      {
        array.push_back(parseValue());
        if (consume(']'))
        {
          break;
        }
        expect(',');
      }
      return Json(std::move(array));
    }

    std::string parseString()
    {
      expect('"');
      std::string output;
      while (pos_ < input_.size())
      {
        char c = input_[pos_++];
        if (c == '"')
        {
          return output;
        }
        if (c != '\\')
        {
          output.push_back(c);
          continue;
        }
        if (pos_ >= input_.size())
        {
          throw std::runtime_error("bad JSON escape");
        }
        char escaped = input_[pos_++];
        switch (escaped)
        {
        case '"':
        case '\\':
        case '/':
          output.push_back(escaped);
          break;
        case 'b':
          output.push_back('\b');
          break;
        case 'f':
          output.push_back('\f');
          break;
        case 'n':
          output.push_back('\n');
          break;
        case 'r':
          output.push_back('\r');
          break;
        case 't':
          output.push_back('\t');
          break;
        case 'u':
          // Keep this parser dependency-free; the React client sends UTF-8
          // directly for ordinary text fields, so unicode escape decoding is not
          // needed here.
          if (pos_ + 4 > input_.size())
          {
            throw std::runtime_error("bad unicode escape");
          }
          output.push_back('?');
          pos_ += 4;
          break;
        default:
          throw std::runtime_error("bad JSON escape");
        }
      }
      throw std::runtime_error("unterminated JSON string");
    }

    double parseNumber()
    {
      const size_t start = pos_;
      if (input_[pos_] == '-')
      {
        ++pos_;
      }
      while (pos_ < input_.size() &&
             std::isdigit(static_cast<unsigned char>(input_[pos_])))
      {
        ++pos_;
      }
      if (pos_ < input_.size() && input_[pos_] == '.')
      {
        ++pos_;
        while (pos_ < input_.size() &&
               std::isdigit(static_cast<unsigned char>(input_[pos_])))
        {
          ++pos_;
        }
      }
      if (pos_ < input_.size() && (input_[pos_] == 'e' || input_[pos_] == 'E'))
      {
        ++pos_;
        if (pos_ < input_.size() &&
            (input_[pos_] == '+' || input_[pos_] == '-'))
        {
          ++pos_;
        }
        while (pos_ < input_.size() &&
               std::isdigit(static_cast<unsigned char>(input_[pos_])))
        {
          ++pos_;
        }
      }
      return std::stod(std::string(input_.substr(start, pos_ - start)));
    }
  };

  std::string jsonEscape(std::string_view value)
  {
    std::string output;
    output.reserve(value.size() + 8);
    for (char c : value)
    {
      switch (c)
      {
      case '"':
        output += "\\\"";
        break;
      case '\\':
        output += "\\\\";
        break;
      case '\b':
        output += "\\b";
        break;
      case '\f':
        output += "\\f";
        break;
      case '\n':
        output += "\\n";
        break;
      case '\r':
        output += "\\r";
        break;
      case '\t':
        output += "\\t";
        break;
      default:
        if (static_cast<unsigned char>(c) < 0x20)
        {
          output += "\\u00";
          const char *hex = "0123456789abcdef";
          const auto byte = static_cast<unsigned char>(c);
          output.push_back(hex[(byte >> 4) & 0xf]);
          output.push_back(hex[byte & 0xf]);
        }
        else
        {
          output.push_back(c);
        }
      }
    }
    return output;
  }

  std::string asString(const Json::Object &object, const std::string &key,
                       std::string fallback = {})
  {
    auto it = object.find(key);
    if (it == object.end())
    {
      return fallback;
    }
    if (auto value = std::get_if<std::string>(&it->second.value))
    {
      return *value;
    }
    return fallback;
  }

  bool asBool(const Json::Object &object, const std::string &key, bool fallback)
  {
    auto it = object.find(key);
    if (it == object.end())
    {
      return fallback;
    }
    if (auto value = std::get_if<bool>(&it->second.value))
    {
      return *value;
    }
    return fallback;
  }

  int asInt(const Json::Object &object, const std::string &key, int fallback)
  {
    auto it = object.find(key);
    if (it == object.end())
    {
      return fallback;
    }
    if (auto value = std::get_if<double>(&it->second.value))
    {
      return static_cast<int>(*value);
    }
    return fallback;
  }

  std::vector<std::string> asStringArray(const Json::Object &object,
                                         const std::string &key,
                                         std::vector<std::string> fallback = {})
  {
    auto it = object.find(key);
    if (it == object.end() || !it->second.isArray())
    {
      return fallback;
    }
    std::vector<std::string> values;
    for (const Json &item : it->second.array())
    {
      if (auto value = std::get_if<std::string>(&item.value);
          value && !value->empty())
      {
        values.push_back(*value);
      }
    }
    return values;
  }

  std::vector<std::string> nestedStringArray(const Json::Object &object,
                                             const std::string &objectKey,
                                             const std::string &arrayKey)
  {
    auto it = object.find(objectKey);
    if (it == object.end() || !it->second.isObject())
    {
      return {};
    }
    return asStringArray(it->second.object(), arrayKey);
  }

  std::string readFile(const fs::path &path, size_t maxBytes = 1'000'000)
  {
    std::ifstream input(path, std::ios::binary);
    if (!input)
    {
      return {};
    }
    std::string data;
    input.seekg(0, std::ios::end);
    const auto size = input.tellg();
    input.seekg(0);
    data.resize(static_cast<size_t>(std::min<std::streamoff>(size, maxBytes)));
    input.read(data.data(), static_cast<std::streamsize>(data.size()));
    return data;
  }

  void writeFile(const fs::path &path, std::string_view content)
  {
    fs::create_directories(path.parent_path());
    std::ofstream output(path, std::ios::binary);
    if (!output)
    {
      throw std::runtime_error("could not write " + path.string());
    }
    output.write(content.data(), static_cast<std::streamsize>(content.size()));
  }

  std::string joinLines(const std::vector<std::string> &values)
  {
    std::string output;
    for (const auto &value : values)
    {
      output += value;
      output += '\n';
    }
    return output;
  }

  struct ProcessResult
  {
    int exitCode = 1;
    std::string output;
  };

  std::string displayCommand(const std::vector<std::string> &args)
  {
    std::string output;
    for (const auto &arg : args)
    {
      if (!output.empty())
      {
        output += ' ';
      }
      const bool needsQuotes =
          arg.empty() || arg.find_first_of(" \t\n\"'\\$") != std::string::npos;
      if (!needsQuotes)
      {
        output += arg;
        continue;
      }
      output += '\'';
      for (char c : arg)
      {
        if (c == '\'')
        {
          output += "'\\''";
        }
        else
        {
          output.push_back(c);
        }
      }
      output += '\'';
    }
    return output;
  }

  ProcessResult runProcess(const std::vector<std::string> &args,
                           const fs::path &workingDirectory)
  {
    if (args.empty())
    {
      throw std::runtime_error("empty command");
    }

    int pipeFd[2];
    if (pipe(pipeFd) != 0)
    {
      throw std::runtime_error("pipe failed");
    }

    pid_t pid = fork();
    if (pid < 0)
    {
      close(pipeFd[0]);
      close(pipeFd[1]);
      throw std::runtime_error("fork failed");
    }

    if (pid == 0)
    {
      dup2(pipeFd[1], STDOUT_FILENO);
      dup2(pipeFd[1], STDERR_FILENO);
      close(pipeFd[0]);
      close(pipeFd[1]);
      if (chdir(workingDirectory.c_str()) != 0)
      {
        _exit(126);
      }

      std::vector<char *> argv;
      argv.reserve(args.size() + 1);
      for (const auto &arg : args)
      {
        argv.push_back(const_cast<char *>(arg.c_str()));
      }
      argv.push_back(nullptr);
      execv(argv[0], argv.data());
      dprintf(STDERR_FILENO, "execv failed for %s: %s\n", argv[0],
              strerror(errno));
      _exit(errno == ENOENT ? 127 : 126);
    }

    close(pipeFd[1]);
    std::string output;
    char buffer[4096];
    bool childExited = false;
    int status = 0;

    while (true)
    {
      pollfd descriptor{pipeFd[0], POLLIN, 0};
      const int pollResult = poll(&descriptor, 1, 100);
      if (pollResult > 0 && (descriptor.revents & POLLIN))
      {
        const ssize_t count = read(pipeFd[0], buffer, sizeof(buffer));
        if (count > 0 && output.size() < 2'000'000)
        {
          output.append(buffer, buffer + count);
        }
      }

      if (!childExited)
      {
        const pid_t waited = waitpid(pid, &status, WNOHANG);
        if (waited == pid)
        {
          childExited = true;
        }
      }

      if (childExited)
      {
        while (true)
        {
          const ssize_t count = read(pipeFd[0], buffer, sizeof(buffer));
          if (count <= 0)
          {
            break;
          }
          if (output.size() < 2'000'000)
          {
            output.append(buffer, buffer + count);
          }
        }
        break;
      }
    }

    close(pipeFd[0]);
    int exitCode = 1;
    if (WIFEXITED(status))
    {
      exitCode = WEXITSTATUS(status);
    }
    else if (WIFSIGNALED(status))
    {
      exitCode = 128 + WTERMSIG(status);
    }
    return {exitCode, output};
  }

  struct JobResult
  {
    std::string json;
    int statusCode = 200;
  };

  std::atomic<uint64_t> jobCounter{0};

  fs::path repoRoot()
  {
    if (const char *env = std::getenv("CFGGEN_REPO_ROOT"); env && *env)
    {
      return fs::absolute(env);
    }
    return fs::current_path();
  }

  fs::path binaryDirectory(const fs::path &root)
  {
    if (const char *env = std::getenv("CFGGEN_BIN_DIR"); env && *env)
    {
      return fs::absolute(env);
    }

    std::error_code error;
    const fs::path self = fs::read_symlink("/proc/self/exe", error);
    if (!error && fs::exists(self.parent_path() / "cfg_generator"))
    {
      return self.parent_path();
    }

    for (const fs::path candidate :
         {root / "build-web", root / "build", root / "build-linux"})
    {
      if (fs::exists(candidate / "cfg_generator"))
      {
        return candidate;
      }
    }

    return root / "build-web";
  }

  std::string makeJobId()
  {
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    const auto millis =
        std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
    return std::to_string(millis) + "-" + std::to_string(++jobCounter);
  }

  void appendArtifact(std::ostringstream &json, const std::string &key,
                      const std::string &jobId, const std::string &artifact,
                      bool &first)
  {
    if (!first)
    {
      json << ',';
    }
    first = false;
    json << '"' << key << "\":\"/api/jobs/" << jsonEscape(jobId) << "/artifacts/"
         << jsonEscape(artifact) << '"';
  }

  JobResult analyze(std::string_view body)
  {
    const auto start = std::chrono::steady_clock::now();
    Json rootJson = JsonParser(body).parse();
    if (!rootJson.isObject())
    {
      throw std::runtime_error("request body must be a JSON object");
    }

    const auto &request = rootJson.object();
    const fs::path root = repoRoot();
    const fs::path bin = binaryDirectory(root);
    const std::string jobId = makeJobId();
    const fs::path jobDir = root / "out" / "web-jobs" / jobId;

    const std::string runtimeLog = asString(request, "runtimeLog");
    const std::string entrypoints = asString(request, "entrypoints");
    if (runtimeLog.empty())
    {
      throw std::runtime_error("runtimeLog is required");
    }
    if (entrypoints.empty())
    {
      throw std::runtime_error("entrypoints is required");
    }

    std::vector<std::string> sourceRoots =
        asStringArray(request, "sourceRoots", {"examples"});
    std::vector<std::string> includeDirs =
        asStringArray(request, "includeDirs", {"."});
    std::vector<std::string> compileFlags =
        asStringArray(request, "compileFlags");
    std::vector<std::string> cfgArgs =
        nestedStringArray(request, "executableArgs", "cfg");
    std::vector<std::string> callgraphArgs =
        nestedStringArray(request, "executableArgs", "callgraph");
    std::vector<std::string> runtimeArgs =
        nestedStringArray(request, "executableArgs", "runtime");

    fs::create_directories(jobDir);
    const fs::path logsFile = jobDir / "runtime.log";
    const fs::path entrypointsFile = jobDir / "entrypoints.txt";
    const fs::path compileArgsFile = jobDir / "compile-args.txt";
    const fs::path cfgOutput = jobDir / "cfg-analysis.json";
    const fs::path callgraphOutput = jobDir / "callgraph.json";
    const fs::path runtimeOutput = jobDir / "runtime-callgraph.json";
    const fs::path runtimeDotOutput = jobDir / "runtime-callgraph.dot";
    const fs::path timelineHtml = jobDir / "runtime-timeline.html";
    const fs::path contextTreeHtml = jobDir / "runtime-context-tree.html";

    writeFile(logsFile, runtimeLog);
    writeFile(entrypointsFile, entrypoints);
    if (!compileFlags.empty())
    {
      writeFile(compileArgsFile, joinLines(compileFlags));
    }

    const int contextDepth = asInt(request, "contextDepth", 3);
    const int topK = asInt(request, "topK", 8);
    const int lookahead = asInt(request, "lookaheadPlainEvents", 8);
    const bool emitDot = asBool(request, "emitDot", true);
    const bool emitHtml = asBool(request, "emitHtml", true);

    std::vector<std::vector<std::string>> commands;
    std::vector<std::string> cfgCommand = {(bin / "cfg_generator").string(), "-o",
                                           cfgOutput.string()};
    for (const auto &includeDir : includeDirs)
    {
      cfgCommand.push_back("--include-dir");
      cfgCommand.push_back(includeDir);
    }
    if (!compileFlags.empty())
    {
      cfgCommand.push_back("--compile-args-file");
      cfgCommand.push_back(compileArgsFile.string());
    }
    cfgCommand.insert(cfgCommand.end(), cfgArgs.begin(), cfgArgs.end());
    cfgCommand.insert(cfgCommand.end(), sourceRoots.begin(), sourceRoots.end());
    commands.push_back(cfgCommand);

    std::vector<std::string> callgraphCommand = {
        (bin / "callgraph_generator").string(),
        "-i",
        cfgOutput.string(),
        "-o",
        callgraphOutput.string(),
        "--context-depth",
        std::to_string(contextDepth)};
    callgraphCommand.insert(callgraphCommand.end(), callgraphArgs.begin(),
                            callgraphArgs.end());
    commands.push_back(callgraphCommand);

    std::vector<std::string> runtimeCommand = {
        (bin / "runtime_callgraph_generator").string(),
        "--logs",
        logsFile.string(),
        "--entrypoints",
        entrypointsFile.string(),
        "--static-callgraph",
        callgraphOutput.string(),
        "--cfg-analysis",
        cfgOutput.string(),
        "-o",
        runtimeOutput.string(),
        "--top-k",
        std::to_string(topK),
        "--lookahead-plain-events",
        std::to_string(lookahead)};
    if (emitDot)
    {
      runtimeCommand.push_back("--dot-output");
      runtimeCommand.push_back(runtimeDotOutput.string());
    }
    else
    {
      runtimeCommand.push_back("--no-dot");
    }
    if (emitHtml)
    {
      runtimeCommand.push_back("--timeline-html");
      runtimeCommand.push_back(timelineHtml.string());
      runtimeCommand.push_back("--context-tree-html");
      runtimeCommand.push_back(contextTreeHtml.string());
    }
    else
    {
      runtimeCommand.push_back("--no-html");
    }
    runtimeCommand.insert(runtimeCommand.end(), runtimeArgs.begin(),
                          runtimeArgs.end());
    commands.push_back(runtimeCommand);

    std::ostringstream combinedLog;
    bool ok = true;
    int failingExitCode = 0;
    for (const auto &command : commands)
    {
      combinedLog << "$ " << displayCommand(command) << "\n";
      ProcessResult result = runProcess(command, root);
      combinedLog << result.output;
      if (!result.output.empty() && result.output.back() != '\n')
      {
        combinedLog << '\n';
      }
      combinedLog << "[exit " << result.exitCode << "]\n\n";
      if (result.exitCode != 0)
      {
        ok = false;
        failingExitCode = result.exitCode;
        break;
      }
    }

    writeFile(jobDir / "run.log", combinedLog.str());
    const auto elapsed = std::chrono::steady_clock::now() - start;
    const auto durationMs =
        std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();

    std::ostringstream json;
    json << "{\"ok\":" << (ok ? "true" : "false") << ",\"jobId\":\""
         << jsonEscape(jobId) << "\",\"durationMs\":" << durationMs
         << ",\"exitCode\":" << failingExitCode << ",\"artifacts\":{";
    bool firstArtifact = true;
    auto appendExisting = [&](const std::string &key, const fs::path &path,
                              const std::string &artifact)
    {
      if (fs::exists(path))
      {
        appendArtifact(json, key, jobId, artifact, firstArtifact);
      }
    };
    appendArtifact(json, "runLog", jobId, "run.log", firstArtifact);
    appendExisting("cfgAnalysis", cfgOutput, "cfg-analysis.json");
    appendExisting("callgraph", callgraphOutput, "callgraph.json");
    appendExisting("runtimeCallgraph", runtimeOutput, "runtime-callgraph.json");
    if (emitDot)
    {
      appendExisting("runtimeDot", runtimeDotOutput, "runtime-callgraph.dot");
    }
    if (emitHtml)
    {
      std::vector<std::pair<std::string, std::string>> htmlArtifacts;
      for (const auto &entry : fs::directory_iterator(jobDir))
      {
        if (!entry.is_regular_file())
        {
          continue;
        }
        const fs::path filePath = entry.path();
        if (filePath.extension() != ".html")
        {
          continue;
        }
        const std::string filename = filePath.filename().string();
        if (filename.rfind("runtime-timeline", 0) != 0)
        {
          continue;
        }
        std::string key;
        key.reserve(filename.size());
        bool capitalize = false;
        for (const char ch : filename.substr(0, filename.size() - 5))
        {
          if (ch == '-' || ch == '.' || ch == '_')
          {
            capitalize = true;
            continue;
          }
          if (capitalize)
          {
            key.push_back(static_cast<char>(std::toupper(ch)));
            capitalize = false;
          }
          else
          {
            key.push_back(ch);
          }
        }
        htmlArtifacts.emplace_back(key, filename);
      }
      std::sort(htmlArtifacts.begin(), htmlArtifacts.end(),
                [](const auto &left, const auto &right)
                {
                  return left.second < right.second;
                });
      for (const auto &artifact : htmlArtifacts)
      {
        appendArtifact(json, artifact.first, jobId, artifact.second,
                       firstArtifact);
      }
    }
    json << "},\"commands\":[";
    for (size_t i = 0; i < commands.size(); ++i)
    {
      if (i != 0)
      {
        json << ',';
      }
      json << '"' << jsonEscape(displayCommand(commands[i])) << '"';
    }
    json << "],\"log\":\"" << jsonEscape(combinedLog.str()) << "\"}";

    return {json.str(), ok ? 200 : 500};
  }

  void addCors(auto *res)
  {
    res->writeHeader("Access-Control-Allow-Origin", "*");
    res->writeHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res->writeHeader("Access-Control-Allow-Headers", "content-type");
  }

  std::string contentTypeFor(const fs::path &path)
  {
    const std::string extension = path.extension().string();
    if (extension == ".json")
    {
      return "application/json";
    }
    if (extension == ".html")
    {
      return "text/html; charset=utf-8";
    }
    if (extension == ".dot" || extension == ".log" || extension == ".txt")
    {
      return "text/plain; charset=utf-8";
    }
    if (extension == ".js")
    {
      return "text/javascript; charset=utf-8";
    }
    if (extension == ".css")
    {
      return "text/css; charset=utf-8";
    }
    return "application/octet-stream";
  }

  std::optional<fs::path> artifactPath(std::string_view job,
                                       std::string_view artifact)
  {
    const std::string jobId(job);
    const std::string name(artifact);
    const bool safeJob =
        std::all_of(jobId.begin(), jobId.end(),
                    [](unsigned char c)
                    { return std::isdigit(c) || c == '-'; });
    const bool safeName =
        std::all_of(name.begin(), name.end(), [](unsigned char c)
                    { return std::isalnum(c) || c == '-' || c == '_' || c == '.'; });
    if (!safeJob || !safeName)
    {
      return std::nullopt;
    }
    fs::path path = repoRoot() / "out" / "web-jobs" / jobId / name;
    if (!fs::exists(path) || !fs::is_regular_file(path))
    {
      return std::nullopt;
    }
    return path;
  }

  void serveFrontend(auto *res, std::string_view url)
  {
    fs::path dist = repoRoot() / "web" / "frontend" / "dist";
    std::string requested(url);
    if (requested == "/")
    {
      requested = "/index.html";
    }
    fs::path path = dist / requested.substr(1);
    if (!fs::exists(path) || fs::is_directory(path))
    {
      path = dist / "index.html";
    }
    if (!fs::exists(path))
    {
      res->writeStatus("404 Not Found");
      res->end("frontend dist not found; run npm run build in web/frontend");
      return;
    }
    res->writeHeader("Content-Type", contentTypeFor(path));
    res->end(readFile(path, 10'000'000));
  }

} // namespace

int main(int argc, char **argv)
{
  int port = 9001;
  if (argc > 1)
  {
    port = std::stoi(argv[1]);
  }
  else if (const char *env = std::getenv("CFGGEN_WEB_PORT"); env && *env)
  {
    port = std::stoi(env);
  }

  auto *loop = uWS::Loop::get();

  uWS::App()
      .options("/*",
               [](auto *res, auto *)
               {
                 addCors(res);
                 res->end();
               })
      .get("/api/health",
           [](auto *res, auto *)
           {
             addCors(res);
             res->writeHeader("Content-Type", "application/json");
             res->end("{\"ok\":true}");
           })
      .post("/api/analyze",
            [loop](auto *res, auto *)
            {
              addCors(res);
              auto body = std::make_shared<std::string>();
              auto aborted = std::make_shared<std::atomic_bool>(false);
              res->onAborted([aborted]()
                             { aborted->store(true); });
              res->onData([res, loop, body, aborted](std::string_view chunk,
                                                     bool isLast)
                          {
                body->append(chunk.data(), chunk.size());
                if (body->size() > 64 * 1024 * 1024) {
                  res->writeStatus("413 Payload Too Large");
                  res->end(
                      "{\"ok\":false,\"error\":\"request body is too large\"}");
                  aborted->store(true);
                  return;
                }
                if (!isLast || aborted->load()) {
                  return;
                }

                std::thread([res, loop, body, aborted]() {
                  JobResult result;
                  try {
                    result = analyze(*body);
                  } catch (const std::exception &error) {
                    result.statusCode = 400;
                    result.json = "{\"ok\":false,\"error\":\"" +
                                  jsonEscape(error.what()) + "\"}";
                  }

                  loop->defer(
                      [res, result = std::move(result), aborted]() mutable {
                        if (aborted->load()) {
                          return;
                        }
                        if (result.statusCode == 400) {
                          res->writeStatus("400 Bad Request");
                        } else if (result.statusCode == 200) {
                          res->writeStatus("200 OK");
                        } else {
                          res->writeStatus("500 Internal Server Error");
                        }
                        addCors(res);
                        res->writeHeader("Content-Type", "application/json");
                        res->end(result.json);
                      });
                }).detach(); });
            })
      .get("/api/jobs/:job/artifacts/:artifact",
           [](auto *res, auto *req)
           {
             addCors(res);
             const auto path =
                 artifactPath(req->getParameter(0), req->getParameter(1));
             if (!path)
             {
               res->writeStatus("404 Not Found");
               res->end("artifact not found");
               return;
             }
             res->writeHeader("Content-Type", contentTypeFor(*path));
             res->end(readFile(*path, 20'000'000));
           })
      .get("/*",
           [](auto *res, auto *req)
           { serveFrontend(res, req->getUrl()); })
      .listen(port,
              [port](auto *token)
              {
                if (token)
                {
                  std::cout
                      << "runtime web backend listening on http://localhost:"
                      << port << "\n";
                }
                else
                {
                  std::cerr << "failed to listen on port " << port << "\n";
                }
              })
      .run();
}
