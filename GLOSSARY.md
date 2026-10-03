# Usage Pace

Usage Pace distinguishes reported quota exhaustion from forecasts of future exhaustion.

## Language

**Quota window**:
A provider-reported usage allowance that renews at a scheduled reset. An account may have overlapping session, weekly, or model-specific windows.

**Confirmed exhaustion**:
A quota window reported by the provider as fully consumed. A forecast alone does not confirm exhaustion.
_Avoid_: Estimated exhaustion

**Projected exhaustion**:
The forecast time when a quota window would be fully consumed at the observed usage rate. Passing that time does not establish confirmed exhaustion.

**Reset countdown**:
The time until the latest scheduled reset among an account's exhausted quota windows. It describes reported quota renewal, not a guarantee that every model or service will become available.
