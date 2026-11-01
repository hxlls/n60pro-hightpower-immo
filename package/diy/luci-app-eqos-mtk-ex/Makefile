include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for Easy QoS (extended, HNAT queue pool)
# The mtkhqos_util conflict is safe here and deliberate.  In r1 it was unsafe
# only because nothing else owned the bridge-nf sysctl; since r3 eqosex itself
# enforces bridge-nf-call-iptables=0 (ensure_bridge_nf_off), so the package is
# not needed for that any more.  Keeping the conflict guarantees mtkhnat's
# hqos=1 branch can never come up on this firmware and write 1 behind our back
# (that write is what killed every proxied session, see conclusion-ledger B1).
LUCI_DEPENDS:=+nftables +kmod-mediatek_hnat +kmod-nft-connlimit @!PACKAGE_luci-app-eqos @!PACKAGE_luci-app-eqos-mtk @!PACKAGE_mtkhqos_util

PKG_MAINTAINER:=ling <ling@users.noreply.github.com>
PKG_NAME:=luci-app-eqos-mtk-ex
PKG_VERSION:=1.0.0
PKG_RELEASE:=4

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
