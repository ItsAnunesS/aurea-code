#[cfg(target_os = "linux")]
fn desktop_id(path: Option<&std::ffi::OsStr>) -> String {
    path.and_then(|path| std::path::Path::new(path).file_name())
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".desktop"))
        .filter(|name| {
            !name.is_empty()
                && name.to_ascii_lowercase().contains("aurea")
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
        .unwrap_or("aurea-code")
        .to_string()
}

pub fn configure() {
    #[cfg(target_os = "linux")]
    {
        use std::ffi::{c_char, CString};
        unsafe extern "C" {
            fn g_set_prgname(name: *const c_char);
            fn g_set_application_name(name: *const c_char);
        }
        // Both executables belong to the same desktop launcher. GLib copies these
        // strings; set them before GTK initialization so X11 and Wayland agree.
        let launcher = std::env::var_os("GIO_LAUNCHED_DESKTOP_FILE");
        let name =
            CString::new(desktop_id(launcher.as_deref())).expect("Validated desktop identifier");
        unsafe {
            g_set_prgname(name.as_ptr());
            g_set_application_name(c"Aurea Code".as_ptr());
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    #[test]
    fn matches_the_installed_launcher_and_falls_back_for_direct_launches() {
        assert_eq!(desktop_id(None), "aurea-code");
        assert_eq!(
            desktop_id(Some(OsStr::new(
                "/usr/share/applications/org.gnome.Terminal.desktop"
            ))),
            "aurea-code"
        );
        assert_eq!(
            desktop_id(Some(OsStr::new(
                "/home/user/.local/share/applications/aurea_code.desktop"
            ))),
            "aurea_code"
        );
        assert_eq!(
            desktop_id(Some(OsStr::new("/tmp/appimagekit-aurea-code.desktop"))),
            "appimagekit-aurea-code"
        );
        assert_eq!(
            desktop_id(Some(OsStr::new("/tmp/invalid name.desktop"))),
            "aurea-code"
        );
    }
}
