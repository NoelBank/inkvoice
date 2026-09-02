// Whether this deployment is operator-managed (a hosted product) or self-hosted.
// The Plugins tab is shared code, and several of its affordances only make sense
// when the person reading it also runs the server: "update Inkvoice" with a link
// to GitHub releases, and the switch that turns catalog egress off. In a hosted
// deployment the reader is a customer who can do neither, so the tab must know
// which it is.
//
// Default false, so OSS behaviour is unchanged and an overlay opts in at boot
// alongside the other plugin policies.

let managed = false;

export function setManagedDeployment(value: boolean): void {
  managed = value;
}

export function isManagedDeployment(): boolean {
  return managed;
}
