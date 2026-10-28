plugins {
    id("com.android.application")
}

// GitHub Actions でビルドしたときは実行番号をバージョンにする（上書きインストールできるように）
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "jp.miminavi.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "jp.miminavi.app"
        minSdk = 26
        targetSdk = 36
        versionCode = buildNumber
        versionName = "0.1.$buildNumber"
    }

    // PoC 用。どこでビルドしても同じ署名になるよう、リポジトリ内のデバッグ用キーを使う。
    // （このキーは公開してよい検証用のもの。ストア公開用の署名には使わないこと）
    signingConfigs {
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
