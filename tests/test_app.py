import asyncio

from fineprint.app import with_heartbeat


async def slow_chunks():
    yield "a"
    await asyncio.sleep(0.05)
    yield "b"


async def test_heartbeat_fills_gaps_and_keeps_order():
    out = [c async for c in with_heartbeat(slow_chunks(), every=0.01)]
    assert out[0] == "a" and out[-1] == "b"
    assert ": keep-alive\n\n" in out


async def test_no_heartbeat_when_chunks_are_fast():
    async def fast():
        for c in "xyz":
            yield c

    assert [c async for c in with_heartbeat(fast(), every=1)] == ["x", "y", "z"]
