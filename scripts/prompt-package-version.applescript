on run argv
  set currentVersion to item 1 of argv
  set dialogResult to display dialog "请输入本次打包的版本号（例如 0.2.5）：" default answer currentVersion with title "图片压缩工作台 Mac 打包" buttons {"取消", "开始打包"} default button "开始打包" cancel button "取消"
  return text returned of dialogResult
end run
