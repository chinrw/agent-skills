{ catalog }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.agent-skills;
  available = lib.unique (builtins.concatMap builtins.attrNames (builtins.attrValues catalog));
  shared = lib.filterAttrs (name: _: !(lib.elem name cfg.exclude)) catalog.shared;
  native = tool: lib.filterAttrs (name: _: !(lib.elem name cfg.exclude)) (catalog.${tool} or { });
  entriesIn =
    directory: skills:
    lib.mapAttrsToList (name: source: {
      target = "${config.home.homeDirectory}/${directory}/${name}";
      inherit source;
    }) skills;
  entries = lib.optionals (cfg.enable && cfg.tools != [ ]) (
    entriesIn ".agents/skills" shared
    ++ lib.optionals (lib.elem "claude-code" cfg.tools) (
      entriesIn ".claude/skills" (shared // native "claude-code")
    )
    ++ lib.optionals (lib.elem "codex" cfg.tools) (entriesIn ".codex/skills" (native "codex"))
  );
  arguments = lib.concatMapStringsSep " " (
    entry: "${lib.escapeShellArg entry.target} ${lib.escapeShellArg entry.source}"
  ) entries;

in
{
  options.programs.agent-skills = {
    enable = lib.mkEnableOption "skills from the agent-skills flake";
    tools = lib.mkOption {
      type = lib.types.listOf (
        lib.types.enum [
          "claude-code"
          "codex"
          "pi"
        ]
      );
      default = [
        "claude-code"
        "codex"
        "pi"
      ];
      description = "Native entrypoints to install. Codex and pi discover shared skills in ~/.agents/skills.";
    };
    exclude = lib.mkOption {
      type = lib.types.listOf (lib.types.enum available);
      default = [ ];
      description = "Skill names to omit from every entrypoint.";
    };
  };

  config = {
    assertions = [
      {
        assertion =
          lib.intersectLists (builtins.attrNames catalog.shared) (
            builtins.attrNames catalog.claude-code ++ builtins.attrNames catalog.codex
          ) == [ ];
        message = "Shared and native agent-skills must have distinct names.";
      }
    ];

    home.activation.agentSkills = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      (
        export PATH=${pkgs.coreutils}/bin:$PATH
        source ${./install-skills.sh}
        install_agent_skills ${lib.escapeShellArg config.home.homeDirectory} \
          ${lib.escapeShellArg "${config.xdg.stateHome}/agent-skills"} ${arguments}
      )
    '';
  };
}
