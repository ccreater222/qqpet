import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val pkg = JsonSlurper().parse(rootDir.resolve("../package.json")) as Map<*, *>
val version = pkg["version"] as String
// Release signing: CI uses the ANDROID_* environment; a local developer can keep the
// same values in android/keystore.properties (gitignored, chmod 600) and run Gradle
// directly. Environment variables win when both are present.
val keystoreProps = Properties()
val keystorePropsFile = rootProject.file("keystore.properties")
if (keystorePropsFile.isFile) keystorePropsFile.inputStream().use { keystoreProps.load(it) }
fun credential(env: String, key: String): String? = System.getenv(env) ?: keystoreProps.getProperty(key)
val keystore: String? = credential("ANDROID_KEYSTORE", "storeFile")

android {
    namespace = "net.ankio.qqpet"
    compileSdk = 35

    defaultConfig {
        applicationId = "net.ankio.qqpet"
        minSdk = 30
        targetSdk = 35
        // 1.2.3 -> 10203: installs only upgrade to a larger code.
        versionCode = version.substringBefore('-').split('.').fold(0) { code, part -> code * 100 + part.toInt() }
        versionName = version
    }

    // The web build (npm run build:android-web) and the pet art are served from assets.
    sourceSets["main"].assets.srcDirs(rootDir.resolve("../out/android"), rootDir.resolve("../resources"))

    androidResources {
        // Already-compressed media; wasm is compiled straight from the stream.
        noCompress += listOf("swf", "png", "gif", "jpg", "mp3", "wasm")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Without ANDROID_KEYSTORE the APK is unsigned and will not install.
            if (keystore != null) signingConfig = signingConfigs.create("release") {
                storeFile = file(keystore)
                storePassword = credential("ANDROID_KEYSTORE_PASSWORD", "storePassword")
                keyAlias = credential("ANDROID_KEY_ALIAS", "keyAlias")
                keyPassword = credential("ANDROID_KEY_PASSWORD", "keyPassword")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.named("preBuild") {
    doFirst {
        val webIndex = rootDir.resolve("../out/android/index.html")
        check(webIndex.isFile) {
            "Android web assets are missing. Run `npm run build:android-web` from the repository root before building with Gradle."
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
