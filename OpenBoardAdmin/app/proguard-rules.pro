# 管理端混淆规则
# 数据模型走 Gson 反射，字段名不能改，否则接口解析失败
-keep class com.openboard.admin.data.model.** { *; }
-keepattributes Signature
-keepattributes *Annotation*
