{
  description = "Agent skills with a Home Manager installer";

  outputs =
    { self }:
    let
      catalog = import ./nix/catalog.nix { source = self; };
    in
    {
      lib.skills = catalog;
      homeManagerModules.default = import ./nix/home-manager.nix { inherit catalog; };
    };
}
