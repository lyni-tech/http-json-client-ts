export class RpcError extends Error {
}

export class TimeoutError extends RpcError {
    message = "Error talking to server.  Please try again."
}

export class NetworkError extends RpcError {
    message = "Error connecting to server.  Please check your connection."
}

export class UserError extends RpcError {
    status: number

    constructor(message: string, status: number) {
        super(message)
        this.status = status
    }
}

export class ServerError extends RpcError {
    status: number | undefined

    constructor(message: string, status?: number | undefined) {
        super(`Error talking to server: ${message}`)
        this.status = status
    }
}

async function doFetch(
    method: string, url: URL | string,
    body: Object | undefined,
    opts?: {
        timeout_ms?: number | undefined,
        headers?: Record<string, string> | undefined,
    } | undefined,
): Promise<Response> {
    const abortController = new AbortController()
    const options: RequestInit = {
        cache: "no-store",
        credentials: "omit",
        headers: opts?.headers,
        method: method,
        redirect: "error",
        signal: abortController.signal,
    }
    if (body != undefined) {
        options.body = JSON.stringify(body)
        options.headers = {"content-type": "application/json", ...opts?.headers}
    }
    const timeout_ms = opts?.timeout_ms ?? 5000
    let timedOut = false
    const timeoutId = setTimeout(() => {
        timedOut = true
        abortController.abort()
    }, timeout_ms)
    try {
        return await fetch(url, options)
    } catch (e) {
        if (timedOut) {
            throw new TimeoutError()
        } else {
            throw new NetworkError()
        }
    } finally {
        clearTimeout(timeoutId)
    }
}

function contentTypeHeader(response: Response): string {
    return (response.headers.get('content-type') ?? "").toLowerCase()
}

function hasBody(response: Response): boolean {
    const contentLength = Number.parseInt(response.headers.get('content-length') ?? "0")
    return contentLength > 0
}

async function readJsonObject(res: Response): Promise<Object> {
    const contentType = contentTypeHeader(res)
    if (!contentType.startsWith("application/json")) {
        throw new ServerError(`server response content-type is not json: ${JSON.stringify(contentType)}`)
    }
    let result: any
    try {
        result = await res.json()
    } catch (e) {
        console.error(e)
        if (e instanceof SyntaxError) {
            throw new ServerError('server returned malformed json data')
        } else {
            throw new NetworkError()
        }
    }
    if (typeof result != "object") {
        throw new ServerError(`server response is not a JSON object: ${JSON.stringify(result)}`)
    }
    // console.log(`doRpc response body ${JSON.stringify(result)}`)
    return result as Object
}

async function tryReadJsonObject(res: Response): Promise<any | undefined> {
    if (!hasBody(res)) {
        return undefined
    }
    if (!contentTypeHeader(res).startsWith("application/json")) {
        return undefined
    }
    try {
        const result = await res.json()
        if (typeof result != "object") {
            return undefined
        }
        // console.log(`doRpc response body ${JSON.stringify(result)}`)
        return result
    } catch (e) {
        console.error(e)
        return undefined
    }
}

async function tryReadText(res: Response): Promise<string | undefined> {
    if (!hasBody(res)) {
        return undefined
    }
    if (!contentTypeHeader(res).startsWith("text/plain")) {
        return undefined
    }
    try {
        return await res.text()
    } catch (e) {
        console.error(e)
        return undefined
    }
}

export async function doRpc(
    method: string,
    url: URL | string,
    body: Object | undefined,
    opts?: {
        timeout_ms?: number | undefined,
        headers?: Record<string, string> | undefined,
    } | undefined,
): Promise<Object> {
    // console.log(`doRpc request ${method} ${url.toString()} ${JSON.stringify(body)}`)
    const response = await doFetch(method, url, body, opts)
    if (200 <= response.status && response.status <= 299) {
        if (!hasBody(response)) {
            return {}
        } else {
            return await readJsonObject(response)
        }
    }
    const responseJson = await tryReadJsonObject(response)
    if (responseJson !== undefined && typeof responseJson.user_error_message === "string") {
        throw new UserError(responseJson.user_error_message, response.status)
    }
    const responseText = await tryReadText(response)
    if (responseText !== undefined) {
        throw new ServerError(`${response.status} ${response.statusText}, ${responseText}`, response.status)
    }
    throw new ServerError(`${response.status} ${response.statusText}`, response.status)
}
