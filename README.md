# http-json-client-ts
A TypeScript library for making HTTP requests with JSON.
- No dependencies
- 100% test coverage
- Supports Browser and Node.js

## Example

```typescript
import {doRpc, NetworkError, ServerError, TimeoutError, UserError} from '@lyni/http-json-client'

try {
    return await doRpc(
        "POST",
        "https://api.example.com/settings-save",
        {feature1: true, option2: "abc"},
        {timeout_ms: 10_000, headers: {'header1': 'val1'}},
    )
} catch (e) {
    if (e instanceof NetworkError) {
        console.log("Error talking to server.  Check your network connection.")
    } else if (e instanceof TimeoutError) {
        console.log("Error talking to server.  Please try again later.")
    } else if (e instanceof ServerError) {
        console.log(`Error talking to server: ${e.message} (${e.status ?? 0})`)
    } else if (e instanceof UserError) {
        console.log(`Server returned ${JSON.stringify({user_error_message: e.message})} (${e.status})`)
    }
}
```
