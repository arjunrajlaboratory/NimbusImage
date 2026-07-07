from girder_claude_chat.rate_limit import SlidingWindowRateLimiter


def testAllowsRequestsUnderTheLimit():
    limiter = SlidingWindowRateLimiter(max_requests=3, window_seconds=60)
    assert all(limiter.check('user', now=float(i)) for i in range(3))


def testBlocksRequestsOverTheLimit():
    limiter = SlidingWindowRateLimiter(max_requests=3, window_seconds=60)
    for i in range(3):
        assert limiter.check('user', now=float(i))
    assert not limiter.check('user', now=3.0)
    # A blocked request is not recorded, so it doesn't extend the window
    assert not limiter.check('user', now=4.0)


def testWindowSlides():
    limiter = SlidingWindowRateLimiter(max_requests=2, window_seconds=60)
    assert limiter.check('user', now=0.0)
    assert limiter.check('user', now=1.0)
    assert not limiter.check('user', now=2.0)
    # Once the first request falls out of the trailing window, a new
    # request is allowed again.
    assert limiter.check('user', now=61.0)


def testKeysAreIndependent():
    limiter = SlidingWindowRateLimiter(max_requests=1, window_seconds=60)
    assert limiter.check('alice', now=0.0)
    assert not limiter.check('alice', now=1.0)
    assert limiter.check('bob', now=1.0)
