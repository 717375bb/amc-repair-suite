/**
 * Given an order's current location (e.g. "DCA/USSTG", as seen verbatim in
 * the recording's own inventory-row text), extract the station code and
 * return "<code>/DOCK" — the value that gets filled into Return to Location.
 * Confirmed against the recording: DCA/USSTG -> DCA/DOCK.
 *
 * Throws rather than guessing if the input doesn't match the expected
 * "<CODE>/..." shape — a malformed source location shouldn't silently
 * produce a wrong return-to-location value.
 */
export function transformReturnToLocation(currentLocation: string): string {
  const match = currentLocation.trim().match(/^([A-Z0-9]+)\//);
  if (!match) {
    throw new Error(
      `Could not extract a station code from return-to-location value "${currentLocation}" — expected a "<CODE>/..." shape.`,
    );
  }
  return `${match[1]}/DOCK`;
}
