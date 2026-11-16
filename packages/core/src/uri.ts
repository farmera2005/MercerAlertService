/**
 * SWIS entity URIs look like:
 *   swis://orion.mercer.local/Orion/Orion.Nodes/NodeID=12
 *   swis://orion.mercer.local/Orion/Orion.Nodes/NodeID=12/Interfaces/InterfaceID=34
 *   swis://orion.mercer.local/Orion/Orion.Nodes/NodeID=12/Volumes/VolumeID=5
 *   swis://orion.mercer.local/Orion/Orion.Groups/ContainerID=7
 *   swis://.../Orion/Orion.Nodes/NodeID=12/Applications/ApplicationID=99
 */
export interface ParsedSwisUri {
  nodeId?: number;
  interfaceId?: number;
  volumeId?: number;
  applicationId?: number;
  containerId?: number;
}

const KEYS: Array<[keyof ParsedSwisUri, RegExp]> = [
  ['nodeId', /\/NodeID=(\d+)/i],
  ['interfaceId', /\/InterfaceID=(\d+)/i],
  ['volumeId', /\/VolumeID=(\d+)/i],
  ['applicationId', /\/ApplicationID=(\d+)/i],
  ['containerId', /\/ContainerID=(\d+)/i],
];

export function parseSwisUri(uri: string | null | undefined): ParsedSwisUri {
  const out: ParsedSwisUri = {};
  if (!uri) return out;
  for (const [key, re] of KEYS) {
    const m = re.exec(uri);
    if (m?.[1]) out[key] = Number(m[1]);
  }
  return out;
}
