{ source }:
let
  discover =
    directory:
    let
      entries = builtins.readDir "${source}/${directory}";
      names = builtins.filter (
        name:
        entries.${name} == "directory" && builtins.pathExists "${source}/${directory}/${name}/SKILL.md"
      ) (builtins.attrNames entries);
    in
    builtins.listToAttrs (
      map (name: {
        inherit name;
        value = "${source}/${directory}/${name}";
      }) names
    );
in
{
  shared = discover "shared-skills";
  claude-code = discover "skills";
  codex = discover "codex-skills";
}
