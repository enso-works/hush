require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Named BavrkHushCapacitor: the Podfile `npx cap sync` writes asks for the pod
# by the name it derives from "@bavrk/hush-capacitor".
Pod::Spec.new do |s|
  s.name = 'BavrkHushCapacitor'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = package['homepage']
  s.author = package['author']
  s.source = { :git => 'https://github.com/enso-works/hush.git', :tag => 'capacitor-v' + package['version'] }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.weak_frameworks = 'AdAttributionKit'
  s.swift_version = '5.9'
end
