//! 本机网络接口工具：局域网 IPv4 列表（对齐 node os.networkInterfaces）与本机局域网 IP 回退。

use if_addrs::{get_if_addrs, IfAddr};

/// 本机一个 IPv4 接口的信息（对齐 node `os.networkInterfaces()` 的非 internal IPv4 项）。
pub struct IpInfo {
    pub name: String,
    pub address: String,
    pub netmask: String,
}

/// 列出所有非回环 IPv4 接口（对齐 server.cjs GET /api/local-ip）。
pub fn list_ipv4() -> Vec<IpInfo> {
    let mut out = Vec::new();
    if let Ok(ifaces) = get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let IfAddr::V4(v4) = iface.addr {
                out.push(IpInfo {
                    name: iface.name.clone(),
                    address: v4.ip.to_string(),
                    netmask: v4.netmask.to_string(),
                });
            }
        }
    }
    out
}

/// 本机第一个局域网 IPv4（排除回环与 169.254 链路本地）。
/// 对齐 lib/live.cjs 的 localIpv4()：客户端与服务器同机（回环连接）时使用。
pub fn local_lan_ipv4() -> Option<String> {
    if let Ok(ifaces) = get_if_addrs() {
        for iface in ifaces {
            if iface.is_loopback() {
                continue;
            }
            if let IfAddr::V4(v4) = iface.addr {
                let s = v4.ip.to_string();
                if !s.starts_with("169.254") {
                    return Some(s);
                }
            }
        }
    }
    None
}
