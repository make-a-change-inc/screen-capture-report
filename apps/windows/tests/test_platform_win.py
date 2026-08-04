from src.platform_win import elapsed_tick_seconds


def test_elapsed_tick_seconds_handles_normal_elapsed_time() -> None:
    assert elapsed_tick_seconds(12_500, 10_000) == 2.5


def test_elapsed_tick_seconds_handles_32_bit_wrap() -> None:
    assert elapsed_tick_seconds(1_000, 0xFFFF_FC18) == 2.0
