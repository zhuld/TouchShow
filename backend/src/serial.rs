//! 串口桥接（原生 serialport crate，替代原 PowerShell + .NET 常驻进程）。
//!
//! 对外行为对齐 lib/serial-bridge.cjs：
//!  - 配置来自 config.json 顶层 serial 段；
//!  - /api/serial/status|ports|connect|disconnect|send|action；
//!  - 消息模板：{action}/{label} 占位 + \r \n \t \xHH 转义；模板全为 \xHH 时按字节发送。

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

use crate::config::now_ms;

/// 规整后的串口配置（对齐 normalizeSerial 的缺省语义）。
#[derive(Clone, Debug)]
pub struct SerialCfg {
    pub enabled: bool,
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: f64,
    pub parity: String,
    pub template: String,
}

impl SerialCfg {
    /// 从 config.json 顶层对象规整出 serial 段（对齐 node normalizeSerial）。
    pub fn normalize(cfg: &Value) -> Self {
        let s = cfg.get("serial").cloned().unwrap_or_else(|| Value::Null);
        let get_str = |k: &str, d: &str| -> String {
            s.get(k)
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .unwrap_or_else(|| d.to_string())
        };
        let get_num = |k: &str, d: f64| -> f64 {
            s.get(k)
                .and_then(|v| v.as_f64())
                .unwrap_or_else(|| {
                    // 兼容数字字符串（如 "9600"）
                    s.get(k)
                        .and_then(|v| v.as_str())
                        .and_then(|x| x.trim().parse::<f64>().ok())
                        .unwrap_or(d)
                })
        };
        let baud = get_num("baudRate", 9600.0) as u32;
        let data_bits = get_num("dataBits", 8.0) as u8;
        let stop_bits = get_num("stopBits", 1.0);
        SerialCfg {
            enabled: s.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false),
            port: get_str("port", "").trim().to_string(),
            baud_rate: if baud == 0 { 9600 } else { baud },
            data_bits: if data_bits == 0 { 8 } else { data_bits },
            stop_bits: if stop_bits == 0.0 { 1.0 } else { stop_bits },
            parity: get_str("parity", "none").to_lowercase(),
            template: {
                let t = get_str("template", "{action}\r\n");
                if t.is_empty() {
                    "{action}\r\n".to_string()
                } else {
                    t
                }
            },
        }
    }

    /// 序列化为 camelCase JSON 对象（对齐 status.config 的结构）。
    fn to_json(&self) -> Value {
        serde_json::json!({
            "enabled": self.enabled,
            "port": self.port,
            "baudRate": self.baud_rate,
            "dataBits": self.data_bits,
            "stopBits": self.stop_bits,
            "parity": self.parity,
            "template": self.template,
        })
    }
}

/// 最近一次发送记录。
#[derive(Clone, Serialize)]
pub struct LastSend {
    pub time: u64,
    pub data: String,
}

/// 串口运行时状态（与节点进程内状态对应）。
pub struct SerialInner {
    pub cfg: SerialCfg,
    pub connected: bool,
    pub error: Option<String>,
    /// 已打开的串口句柄
    pub port: Option<Box<dyn serialport::SerialPort>>,
    pub last_send: Option<LastSend>,
}

/// 串口管理器句柄（多任务共享）。
pub type SerialManager = Arc<Mutex<SerialInner>>;

pub fn new_manager() -> SerialManager {
    Arc::new(Mutex::new(SerialInner {
        cfg: SerialCfg {
            enabled: false,
            port: String::new(),
            baud_rate: 9600,
            data_bits: 8,
            stop_bits: 1.0,
            parity: "none".to_string(),
            template: "{action}\r\n".to_string(),
        },
        connected: false,
        error: None,
        port: None,
        last_send: None,
    }))
}

/// 构建串口报文（对齐 node buildSerialMessage 的精确语义）。
pub struct BuiltMsg {
    /// 转义还原后的文本报文（\r\n 等已变真实控制字符）
    pub str_val: String,
    /// 模板仅由 \xHH 组成（十六进制原始字节模式）
    pub hex_only: bool,
    /// 十六进制字节串（空格分隔，形如 "AA 55"），仅 hex_only 时有意义
    pub hex_data: String,
}

/// 判定字符串是否整体由 `\xHH`（可夹空白）组成。
fn is_hex_only(t: &str) -> bool {
    let bytes = t.as_bytes();
    let mut i = 0;
    let mut any = false;
    loop {
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        // 期望 \xHH
        if bytes[i] != b'\\' || i + 3 >= bytes.len() || bytes[i + 1] != b'x' {
            return false;
        }
        let h1 = bytes[i + 2];
        let h2 = bytes[i + 3];
        if !h1.is_ascii_hexdigit() || !h2.is_ascii_hexdigit() {
            return false;
        }
        any = true;
        i += 4;
    }
    any
}

/// 反转义模板：\r \n \t \xHH（对齐 JS String.replace 语义；未知转义保留原样）。
fn unescape(t: &str) -> String {
    let bytes = t.as_bytes();
    let mut out = String::with_capacity(t.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' && i + 1 < bytes.len() {
            let n = bytes[i + 1];
            match n {
                b'r' => {
                    out.push('\r');
                    i += 2;
                    continue;
                }
                b'n' => {
                    out.push('\n');
                    i += 2;
                    continue;
                }
                b't' => {
                    out.push('\t');
                    i += 2;
                    continue;
                }
                b'x' if i + 3 < bytes.len()
                    && bytes[i + 2].is_ascii_hexdigit()
                    && bytes[i + 3].is_ascii_hexdigit() =>
                {
                    let hi = (bytes[i + 2] as char).to_digit(16).unwrap();
                    let lo = (bytes[i + 3] as char).to_digit(16).unwrap();
                    out.push(char::from_u32(hi * 16 + lo).unwrap_or('\u{FFFD}'));
                    i += 4;
                    continue;
                }
                _ => {
                    out.push('\\');
                    out.push(n as char);
                    i += 2;
                    continue;
                }
            }
        }
        // 按 UTF-8 原样拷贝一个字符
        let ch_len = utf8_len(b);
        let ch = std::str::from_utf8(&bytes[i..i + ch_len]).unwrap_or("\u{FFFD}");
        out.push_str(ch);
        i += ch_len;
    }
    out
}

fn utf8_len(first: u8) -> usize {
    if first < 0x80 {
        1
    } else if first >> 5 == 0b110 {
        2
    } else if first >> 4 == 0b1110 {
        3
    } else if first >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

/// 提取模板中的十六进制对，空格连接（对齐 JS hexData 生成）。
fn extract_hex(t: &str) -> String {
    let bytes = t.as_bytes();
    let mut parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() && bytes[i + 1] == b'x' {
            let h1 = bytes[i + 2];
            let h2 = bytes[i + 3];
            if h1.is_ascii_hexdigit() && h2.is_ascii_hexdigit() {
                parts.push(format!("{}{}", h1 as char, h2 as char));
                i += 4;
                continue;
            }
        }
        i += 1;
    }
    parts.join(" ")
}

/// 按模板组装报文（对齐 node buildSerialMessage）。
pub fn build_serial_message(template: &str, action: &str, label: &str) -> BuiltMsg {
    let template = template
        .replace("{action}", action)
        .replace("{label}", label);
    let hex_only = is_hex_only(&template);
    let str_val = unescape(&template);
    let hex_data = extract_hex(&template);
    BuiltMsg {
        str_val,
        hex_only,
        hex_data,
    }
}

fn parity_enum(s: &str) -> serialport::Parity {
    match s {
        // 注：serialport crate v4 仅支持 None/Odd/Even；mark/space 映射为 None
        //（罕见配置，需真硬件验证；config 中仍保留原始字符串供展示）
        "odd" => serialport::Parity::Odd,
        "even" => serialport::Parity::Even,
        _ => serialport::Parity::None,
    }
}

fn data_bits_enum(v: u8) -> serialport::DataBits {
    match v {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    }
}

fn stop_bits_enum(v: f64) -> serialport::StopBits {
    // 注：serialport crate v4 无 OnePointFive；1.5/2 停止位映射为 Two
    if v >= 1.4 {
        serialport::StopBits::Two
    } else {
        serialport::StopBits::One
    }
}

/// 打开一个串口（对齐 worker 'open' 分支的 clamp 语义）。
fn open_port(cfg: &SerialCfg) -> std::io::Result<Box<dyn serialport::SerialPort>> {
    let baud = if cfg.baud_rate == 0 { 9600 } else { cfg.baud_rate };
    let mut port = serialport::new(&cfg.port, baud)
        .data_bits(data_bits_enum(cfg.data_bits))
        .stop_bits(stop_bits_enum(cfg.stop_bits))
        .parity(parity_enum(&cfg.parity))
        .timeout(Duration::from_millis(2000))
        .open()?;
    // v4 只有 set_timeout（读写共用）；写超时由 OS 默认处理
    let _ = port.set_timeout(Duration::from_millis(2000));
    Ok(port)
}

/// 关闭并丢弃当前串口句柄。
pub async fn close(mgr: &SerialManager) {
    let mut g = mgr.lock().await;
    g.port = None;
    g.connected = false;
}

/// 应用串口配置（启动时 / 配置保存后调用）。
/// 未启用或无端口则断开；连接参数变化则重连。
pub async fn apply_config(mgr: &SerialManager, cfg_val: &Value) {
    let s = SerialCfg::normalize(cfg_val);
    let mut g = mgr.lock().await;
    // 记录应用前的连接状态用于判断是否需要重连（先记录再覆盖）
    let prev_port = g.cfg.port.clone();
    let prev_baud = g.cfg.baud_rate;
    let was_connected = g.connected;
    g.cfg = s.clone();
    if !s.enabled || s.port.is_empty() {
        g.port = None;
        g.connected = false;
        g.error = if s.enabled { Some("未指定串口号".into()) } else { None };
        return;
    }
    if was_connected && prev_port == s.port && prev_baud == s.baud_rate {
        return;
    }
    g.port = None;
    g.connected = false;
    match open_port(&s) {
        Ok(p) => {
            g.port = Some(p);
            g.connected = true;
            g.error = None;
            println!("[serial] 已连接 {} @ {}", s.port, s.baud_rate);
        }
        Err(e) => {
            g.connected = false;
            g.error = Some(e.to_string());
            println!("[serial] 打开失败：{}", g.error.as_deref().unwrap_or(""));
        }
    }
}

/// 确保串口按当前配置已连接（未连接时按当前配置重连一次）。
/// 未启用/无端口时返回 Ok（具体报错由调用方按配置给出）。
async fn ensure_connected(mgr: &SerialManager) -> Result<(), String> {
    let mut g = mgr.lock().await;
    if g.connected {
        return Ok(());
    }
    let s = g.cfg.clone();
    if !s.enabled || s.port.trim().is_empty() {
        return Ok(());
    }
    match open_port(&s) {
        Ok(p) => {
            g.port = Some(p);
            g.connected = true;
            g.error = None;
            Ok(())
        }
        Err(e) => {
            g.error = Some(e.to_string());
            Err(g.error.clone().unwrap_or_else(|| "串口未连接".into()))
        }
    }
}

/// 写一条报文（text 按 UTF-8、hex 按字节）。未连接时自动重连。
pub async fn write_message(mgr: &SerialManager, data: &str, hex_only: bool) -> Result<(), String> {
    {
        let g = mgr.lock().await;
        if !g.cfg.enabled {
            return Err("串口未启用（config.json 的 serial.enabled=false）".into());
        }
        if g.cfg.port.trim().is_empty() {
            return Err("未配置串口号".into());
        }
    }
    ensure_connected(mgr).await?;
    let bytes: Vec<u8> = if hex_only {
        data.split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|h| u8::from_str_radix(h, 16).unwrap_or(0))
            .collect()
    } else {
        data.as_bytes().to_vec()
    };
    let mut g = mgr.lock().await;
    if !g.connected {
        return Err(g.error.clone().unwrap_or_else(|| "串口未连接".into()));
    }
    let res = match g.port.as_mut() {
        Some(p) => p.write_all(&bytes).and_then(|_| p.flush()),
        None => Err(std::io::Error::new(
            std::io::ErrorKind::NotConnected,
            "serial port not open",
        )),
    };
    if let Err(e) = res {
        return Err(format!("串口写入失败：{e}"));
    }
    g.last_send = Some(LastSend {
        time: now_ms(),
        data: data.to_string(),
    });
    Ok(())
}

/// 当前状态 JSON（对齐 getSerialStatus 结构）。
pub async fn status_json(mgr: &SerialManager) -> Value {
    let g = mgr.lock().await;
    serde_json::json!({
        "ok": true,
        "config": g.cfg.to_json(),
        "connected": g.connected,
        "port": if g.cfg.port.is_empty() { Value::Null } else { Value::String(g.cfg.port.clone()) },
        "baudRate": g.cfg.baud_rate,
        "error": g.error,
        "workerAlive": false,
        "lastSend": g.last_send.as_ref().map(|l| serde_json::json!({ "time": l.time, "data": l.data })),
    })
}

/// 本机可用串口列表。
pub fn list_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}

/// JS `str.length` 等价的 UTF-16 码元数（对齐 node 报文字段长度语义）。
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// POST /api/serial/connect：应用配置后返回连接结果对象（对齐 node 响应结构）。
pub async fn connect_json(mgr: &SerialManager, cfg_val: &Value) -> Value {
    apply_config(mgr, cfg_val).await;
    let g = mgr.lock().await;
    serde_json::json!({
        "ok": g.connected,
        "connected": g.connected,
        "port": if g.cfg.port.is_empty() { Value::Null } else { Value::String(g.cfg.port.clone()) },
        "baudRate": g.cfg.baud_rate,
        "error": g.error,
    })
}

/// POST /api/serial/disconnect：断开后返回对象。
pub async fn disconnect_json(mgr: &SerialManager) -> Value {
    close(mgr).await;
    serde_json::json!({ "ok": true, "connected": false })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_default_template_with_action() {
        let b = build_serial_message("{action}\r\n", "A1", "产品");
        assert!(!b.hex_only);
        assert_eq!(b.str_val, "A1\r\n");
    }

    #[test]
    fn message_placeholders_and_escapes() {
        // 占位符替换 + 文本转义
        let b = build_serial_message("P={action};L={label}\\n\\t\\r", "a_b", "灯");
        assert!(!b.hex_only);
        assert_eq!(b.str_val, "P=a_b;L=灯\n\t\r");
    }

    #[test]
    fn message_hex_only_mode() {
        let b = build_serial_message("\\xAA \\x55\\x01", "ignored", "灯");
        assert!(b.hex_only);
        assert_eq!(b.hex_data, "AA 55 01");
    }

    #[test]
    fn message_mixed_is_not_hex_only() {
        // 含普通文本 → 非 hex 模式；\xAA 反转义为字符 U+00AA（对齐 JS String.fromCharCode）
        let b = build_serial_message("\\xAAhello", "", "");
        assert!(!b.hex_only);
        assert_eq!(b.str_val, "\u{AA}hello");
    }

    #[test]
    fn message_action_containing_hexlike_but_placeholder_non_hex() {
        // 占位符替换后含普通文本 → 非 hex 模式
        let b = build_serial_message("\\xAA{action}", "ab", "");
        assert!(!b.hex_only);
        assert_eq!(b.str_val, "\u{AA}ab");
    }

    #[test]
    fn serialize_cfg_json_shape() {
        let v = serde_json::json!({
            "serial": { "enabled": true, "port": "COM3", "baudRate": 115200,
                        "dataBits": 8, "stopBits": 1, "parity": "none", "template": "{action}\\r\\n" }
        });
        let c = SerialCfg::normalize(&v);
        assert_eq!(c.port, "COM3");
        assert_eq!(c.baud_rate, 115200);
        let j = c.to_json();
        assert_eq!(j["baudRate"], 115200);
        assert_eq!(j["template"], "{action}\\r\\n");
    }

    #[test]
    fn normalize_defaults() {
        let v = serde_json::json!({});
        let c = SerialCfg::normalize(&v);
        assert!(!c.enabled);
        assert_eq!(c.baud_rate, 9600);
        assert_eq!(c.template, "{action}\r\n");
    }
}

