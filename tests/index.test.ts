import {Server, Socket} from 'node:net'
import {StringDecoder} from 'node:string_decoder'
import {expect, test} from 'vitest'
import {doRpc, NetworkError, ServerError, TimeoutError, UserError} from '../src/'

export class Stopwatch {
    start_ns: bigint

    constructor() {
        this.start_ns = process.hrtime.bigint()
    }

    elapsed_ms(): number {
        const elapsed_ns = process.hrtime.bigint() - this.start_ns
        const elapsed_us = elapsed_ns / 1000_000n
        return Number(elapsed_us)
    }
}

export async function sleep_ms(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function tcpServer(handler: (socket: Socket) => Promise<void>): Promise<{ server: Server, port: number }> {
    const server = new Server(async (socket: Socket) => {
        try {
            await handler(socket)
        } finally {
            socket.destroy()
        }
    })
    const port = await new Promise<number>((resolve, reject) => {
        server.once('error', (e) => reject(e))
        server.once('listening', () => {
            const address = server.address()
            if (address == null || typeof address === "string") {
                server.close()
                reject(new Error(`Server.address() returned unexpected value: ${JSON.stringify(address)}`))
            } else {
                resolve(address.port)
            }
        });
        server.listen(0)
    })
    return {server, port}
}

export async function withTcpServer<T>(handler: (socket: Socket) => Promise<void>, f: (url: string) => Promise<T>): Promise<T> {
    const {server, port} = await tcpServer(handler)
    try {
        return await f(`http://127.0.0.1:${port}`)
    } finally {
        server.close()
    }
}

export async function writeSocket(socket: Socket, data: string | Uint8Array): Promise<void> {
    await new Promise<void>((resolve, reject) =>
        socket.write(data, (err) => err ? reject(err) : resolve())
    )
}

export async function readSocket(socket: Socket, opts: { read_ms: number }): Promise<string> {
    return await new Promise<string>((resolve, _reject) => {
            const stringDecoder = new StringDecoder()
            const parts: string[] = []
            socket.on('data', (buffer) => {
                parts.push(stringDecoder.write(buffer))
            })
            setTimeout(() => {
                parts.push(stringDecoder.end())
                resolve(parts.join(""))
            }, opts.read_ms)
        }
    )
}

test('timeout', async () => {
    const stopwatch = new Stopwatch()
    await withTcpServer(async (_socket) => sleep_ms(200), async (url) => {
        await expect(() => doRpc("GET", url, undefined, {timeout_ms: 100}))
            .rejects
            .toThrow(new TimeoutError())
    })
    expect(stopwatch.elapsed_ms()).toBeGreaterThanOrEqual(100)
    expect(stopwatch.elapsed_ms()).toBeLessThan(200)
})

test('disconnect', async () => {
    await withTcpServer(async (_socket) => {
    }, async (url) => {
        await expect(() => doRpc("GET", url, undefined))
            .rejects
            .toThrow(new NetworkError())
    })
})

test('non-http response', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, "non-http response"),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new NetworkError())
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('response with content-type but no body', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 200 OK',
            'content-type: application/json',
            '',
        ].join('\r\n')),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new NetworkError())
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('response content-type not json', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 200 OK',
            'content-type: text/plain',
            'content-length: 1',
            '',
            'a',
        ].join('\r\n')),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new ServerError('server response content-type is not json: "text/plain"'))
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('response truncated', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 200 OK',
            'content-type: application/json',
            'content-length: 10',
            '',
            '{"a',
        ].join('\r\n')),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new NetworkError())
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('invalid json', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 200 OK',
            'content-type: application/json',
            'content-length: 1',
            '',
            '$'
        ].join('\r\n'),),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new ServerError('server returned malformed json data'))
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})


test('json but not object', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 200 OK',
            'content-type: application/json',
            'content-length: 1',
            '',
            '1'
        ].join('\r\n'),),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new ServerError('server response is not a JSON object: 1'))
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('GET', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 200 OK',
            'content-type: application/json',
            'content-length: 7',
            '',
            '{"a":1}'
        ].join('\r\n'),),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(doRpc("GET", url, undefined)).resolves.toEqual({a: 1})
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('POST 200 with no body', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 200 OK',
            'content-length: 0',
            '',
            '',
        ].join('\r\n'),),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(doRpc("POST", url, {a: 1})).resolves.toEqual({})
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('POST json', async () => {
    await withTcpServer(
        async (socket) => {
            const req = await readSocket(socket, {read_ms: 100})
            // console.log("readSocket", JSON.stringify(req))
            expect(req).toSatisfy((s: string) => s.endsWith('\r\n\r\n{"a":1}'))
            await writeSocket(socket, [
                'HTTP/1.1 200 OK',
                'content-type: application/json',
                'content-length: 7',
                '',
                '{"a":1}'
            ].join('\r\n'))
        },
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(doRpc("POST", url, {a: 1})).resolves.toEqual({a: 1})
            expect(stopwatch.elapsed_ms()).toBeLessThan(200)
        })
})

test('POST blob', async () => {
    await withTcpServer(
        async (socket) => {
            const req = await readSocket(socket, {read_ms: 100})
            // console.log("readSocket", JSON.stringify(req))
            expect(req).toSatisfy((s: string) => s.endsWith('\r\n\r\na1'))
            await writeSocket(socket, [
                'HTTP/1.1 200 OK',
                'content-type: application/json',
                'content-length: 2',
                '',
                '{}'
            ].join('\r\n'))
        },
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(doRpc("POST", url, new Blob(["a", "1"]))).resolves.toEqual({})
            expect(stopwatch.elapsed_ms()).toBeLessThan(200)
        })
})

test('error', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, 'HTTP/1.1 400 Bad Request\r\n\r\n'),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new ServerError('400 Bad Request', 400))
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('error with truncated text', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 400 Bad Request',
            'content-type: text/plain',
            'content-length: 4',
            '',
            'e'
        ].join('\r\n'),),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new ServerError('400 Bad Request', 400))
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('error with text', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 400 Bad Request',
            'content-type: text/plain',
            'content-length: 4',
            '',
            'err1'
        ].join('\r\n'),),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new ServerError('400 Bad Request, err1', 400))
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('error with malformed json', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 400 Bad Request',
            'content-type: application/json',
            'content-length: 1',
            '',
            '{'
        ].join('\r\n'),),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new ServerError('400 Bad Request', 400))
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})


test('error with non-object', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 400 Bad Request',
            'content-type: application/json',
            'content-length: 1',
            '',
            '1'
        ].join('\r\n'),),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new ServerError('400 Bad Request', 400))
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('user error message', async () => {
    await withTcpServer(
        async (socket) => writeSocket(socket, [
            'HTTP/1.1 400 Bad Request',
            'content-type: application/json',
            'content-length: 29',
            '',
            '{"user_error_message":"err1"}'
        ].join('\r\n'),),
        async (url) => {
            const stopwatch = new Stopwatch()
            await expect(() => doRpc("GET", url, undefined))
                .rejects
                .toThrow(new UserError('err1', 400))
            expect(stopwatch.elapsed_ms()).toBeLessThan(100)
        })
})

test('is400', () => {
    expect((new ServerError('err1', 200)).is400()).toBe(false)
    expect((new ServerError('err1', 300)).is400()).toBe(false)
    expect((new ServerError('err1', 400)).is400()).toBe(true)
    expect((new ServerError('err1', 429)).is400()).toBe(true)
    expect((new ServerError('err1', 499)).is400()).toBe(true)
    expect((new ServerError('err1', 500)).is400()).toBe(false)
})

test('is500', () => {
    expect((new ServerError('err1', 200)).is500()).toBe(false)
    expect((new ServerError('err1', 300)).is500()).toBe(false)
    expect((new ServerError('err1', 400)).is500()).toBe(false)
    expect((new ServerError('err1', 500)).is500()).toBe(true)
    expect((new ServerError('err1', 503)).is500()).toBe(true)
    expect((new ServerError('err1', 599)).is500()).toBe(true)
    expect((new ServerError('err1', 600)).is500()).toBe(false)
})
