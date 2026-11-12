"""本机地址判断：本地服务不该走系统代理（Windows 代理常把 127.0.0.1 也代理成 502）。"""

from core.net import is_loopback_url


def test_loopback_hosts_are_recognized() -> None:
    assert is_loopback_url("http://127.0.0.1:8742/health")
    assert is_loopback_url("http://127.8.9.10:11434/v1")
    assert is_loopback_url("http://localhost:1234/v1")
    assert is_loopback_url("http://[::1]:8737/health")


def test_remote_and_invalid_urls_are_not_loopback() -> None:
    assert not is_loopback_url("https://api.example.com/v1")
    assert not is_loopback_url("http://192.168.1.10:8742/health")
    assert not is_loopback_url("")
    assert not is_loopback_url("not a url")
